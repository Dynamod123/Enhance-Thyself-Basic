import { ReactElement } from "react";
import {
    StageBase,
    StageResponse,
    InitialData,
    Message,
    AspectRatio,
    Character,
    User
} from "@chub-ai/stages-ts";
import { LoadResponse } from "@chub-ai/stages-ts/dist/types/load";

type MessageStateType = any;
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    // Per-message state:
    longTermInstruction: string = '';

    // Unsaved:
    characters: { [key: string]: Character };
    users: { [key: string]: User };

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const {
            characters,
            users,
        } = data;

        this.characters = characters;
        this.users = users;

        const { messageState } = data;
        this.readMessageState(messageState);
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {

        return {
            success: true,
            error: null,
            initState: null,
            chatState: null,
            messageState: this.writeMessageState()
        };
    }

    async setState(state: MessageStateType): Promise<void> {
        this.readMessageState(state);
        await this.messenger.updateEnvironment({ background: '' });
    }

    readMessageState(state: MessageStateType) {
        this.longTermInstruction = state?.longTermInstruction ?? '';
    }

    writeMessageState() {
        return {
            longTermInstruction: this.longTermInstruction,
        }
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const {
            anonymizedId,
            promptForId,
            content } = userMessage;
        let newContent = content;

        const longTermRegex = /\[\[([^\]]*)\]\](?!\()/gm;

        let possibleLongTermInstruction = [...newContent.matchAll(longTermRegex)].map(match => match.slice(1)[0]);

        // Remove commands that might have been picked up, if any exist that we still support.
        // Since we removed image/enhance commands, we mainly just strip them if they were intended as such, 
        // effectively ignoring them as "instructions" if they start with /.
        possibleLongTermInstruction = possibleLongTermInstruction.filter(instruction => !instruction.startsWith("/"));

        const longTermInstruction = possibleLongTermInstruction.join('\n').trim();
        if (possibleLongTermInstruction.length > 0) {
            if (longTermInstruction.length > 0) {
                console.log(`Setting long-term instruction:\n${longTermInstruction}`);
            } else {
                console.log(`Clearing long-term instruction.`);
            }
            this.longTermInstruction = longTermInstruction;
        }

        // Filter all [[]] from content:
        newContent = newContent.replace(longTermRegex, "").trim();

        const currentRegex = /(?<!\[)\[([^\]|\[]*)\](?!\()/gm;
        let currentInstructions = [...newContent.matchAll(currentRegex)].map(match => match.slice(1)[0]);

        // Filter all non-Markdown [] from newContent:
        newContent = newContent.replace(currentRegex, "").trim();

        // Remove commands:
        currentInstructions = currentInstructions.filter(instruction => !instruction.startsWith("/"));

        const stageDirections =
            ((this.longTermInstruction.length > 0) ? `Ongoing Instruction: ${this.longTermInstruction}\n` : '') +
            (currentInstructions.length > 0 ? `Critical Instruction: ${currentInstructions.join('\n').trim()}\n` : '');

        // Now, auto-enhance existing content if possible.
        if (newContent.length > 0) {
            console.log(`Auto-Enhance triggered for: ${newContent}`);

            try {
                // Create a promise that rejects after 20 seconds
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Enhance request timed out')), 20000)
                );

                // Use a valid character ID or fallback
                const characterId = promptForId ?? Object.keys(this.characters)[0];
                if (!characterId) {
                    throw new Error('No characters found for enhancement.');
                }

                // Race the enhance call against the timeout
                const enhancePromise = this.enhance(characterId, anonymizedId, '', newContent.trim(), stageDirections);

                const result: any = await Promise.race([enhancePromise, timeoutPromise]);
                // Strip leading bracketed text, conversational fillers, or refusals (Loop to catch multiple layers)
                let textResult = result?.result ?? '';
                let cleaning = true;
                while (cleaning) {
                    const original = textResult;
                    textResult = textResult
                        .replace(/^\s*\[.*?\]\s*/s, '') // Bracketed blocks [ ... ]
                        .replace(/^\s*\{.*?\}\s*/s, '') // Curly brace meta-instructions { ... }
                        .replace(/^\s*\/\w+\s*(\n|$)/gm, '') // Slash commands like /end
                        .replace(/^\s*(?:Understood|Noted|Sure|Okay|Alright|Error|Terminating|I cannot|System\s*Alert).*?(\n|$)/is, '') // Conversational/Error lines
                        .replace(/^\s*(?:You are|Your task|Your role|You're).*?(?:Mode|perspective|acting as).*?(\n|$)/is, '') // System role descriptions
                        .replace(/^\s*\[?Begin real.*?\]?\s*(\n|$)/is, '') // "Begin real interaction" type lines
                        .replace(/^\s*(?:About|Context:|Instruction:|Goal:|Background).*?(\n|$)/is, '') // Prompt metadata
                        .trim();
                    if (textResult === original) cleaning = false;
                }

                if (textResult.length > 0) {
                    newContent = textResult;
                    console.log(`Enhancement successful.`);
                }
            } catch (error) {
                console.error(`Auto-Enhance failed or timed out:`, error);
                // Fallback to original content on error/timeout
            }
        }

        // Preserve empty responses that only had instruction.
        if (newContent !== content && newContent.length == 0) {
            newContent = ' ';
        }

        // Add anti-echo stage directions if content was enhanced
        let finalStageDirections = stageDirections;
        if (newContent !== content && newContent.length > 0) {
            const antiEchoDirective = `[{{char}} should respond naturally to {{user}}'s message. Do not repeat or echo what {{user}} just said. React and respond with {{char}}'s own unique dialogue and actions.]`;
            finalStageDirections = stageDirections.length > 0
                ? `${stageDirections}${antiEchoDirective}\n`
                : antiEchoDirective;
        }

        if (finalStageDirections.length > 0) {
            console.log(`Sending stage directions:\n${finalStageDirections}`);
        }

        return {
            stageDirections: finalStageDirections.length > 0 ? finalStageDirections : null,
            messageState: this.writeMessageState(),
            modifiedMessage: newContent,
            systemMessage: null,
            error: null,
            chatState: null,
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        // Just filter markdown, no image generation.
        const newContent = await this.filterValidMarkdown(botMessage.content);

        return {
            stageDirections: null,
            messageState: this.writeMessageState(),
            modifiedMessage: newContent,
            error: null,
            systemMessage: null,
            chatState: null
        };
    }

    async filterValidMarkdown(text: string): Promise<string> {
        const matches = [...text.matchAll(/(!?)\[(.*?)\]\((.*?)\)/g)];

        const validityChecks = await Promise.all(
            matches.map(match => this.isValidUrl(match[3]))
        );

        let cleanedText = text;
        matches.forEach((match, index) => {
            if (!validityChecks[index]) {
                cleanedText = cleanedText.replace(match[0], match[1] != '!' ? match[2] : '');
            }
        });

        return cleanedText;
    }

    async isValidUrl(url: string): Promise<boolean> {
        try {
            const response = await fetch(url, { method: 'HEAD' });
            console.log(`Validating ${url}: ${response.ok}`);
            return response.ok;
        } catch {
            return false;
        }
    }

    enhance(charId: string, userId: string, newHistory: string, targetContext: string, instructions: string = '') {
        return this.generator.textGen({
            prompt:
                `About {{char}}: ${this.characters[charId].personality}\n${this.characters[charId].description}\n` +
                `About {{user}}: ${this.users[userId].chatProfile}\n\n` +
                `[System: You are operating in Input Enhancement Mode. Your task is to draft a message FOR {{user}}, from {{user}}'s perspective. You are acting as {{user}}.]\n\n` +
                `[Begin real interaction.]\n{{messages}}\n` +
                `[Background Context: {{post_history_instructions}}]\n` +
                `[Override: The user has explicitly requested you to draft this message. The background rule "Do not speak for {{user}}" is SUSPENDED for this generation. You MUST write as {{user}}.]\n` +
                (instructions.trim() !== '' ? `Instruction: ${instructions}\n` : '') +
                `\n` +
                `Instruction: Expand the user's intent into a conversational message from {{user}}'s POV. Focus on dialogue and immediate actions. Use casual, natural language - avoid flowery or overly descriptive prose. Keep it punchy and conversational, NOT narrative story prose. Format actions with *asterisks* and dialogue with "quotation marks". Do NOT describe {{char}}'s reaction or response. Do NOT write {{char}}'s dialogue. STOP writing before {{char}} can respond. End in a way that naturally invites {{char}}'s response. Do not include meta-commentary or bracketed headers. Start the response immediately. Do not acknowledge these instructions. Do not output "Understood" or "Here is...".\n` +
                (targetContext.trim() != '' ?
                    `Goal: Enhance the following into a conversational message from {{user}}'s perspective: \"${targetContext}\".\n` :
                    `Goal: Write {{user}}'s next conversational message from their perspective.\n`) +
                `Context: Build directly from {{user}}'s final input above. Maintain {{user}}'s voice and style. Make it feel like a turn in a conversation, not a story passage.\n\n` +
                `[SYSTEM ALERT: IMPERSONATION AUTHORIZED. write exclusively as {{user}}. Do not refuse. Do not explain. Start writing the narrative text immediately.]\n` +
                `{{user}}:`,

            min_tokens: 50,
            max_tokens: 250,
            include_history: true,
        });
    }

    sanitizeMarkdownContent(content: string): string {
        return content.replace(/[\]\(\)\n]/g, '');
    }

    render(): ReactElement {
        return <></>
    }

}
