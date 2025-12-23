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
                console.log(`Enhance Result:`, result);
                let textResult = result?.result ?? '';

                // Extract content from <output> tags first if possible
                const fullMatch = textResult.match(/<output>([\s\S]*?)<\/output>/i);
                const partialMatch = textResult.match(/([\s\S]*?)<\/output>/i);
                const openOnlyMatch = textResult.match(/<output>([\s\S]*)/i);

                if (fullMatch && fullMatch[1]) {
                    textResult = fullMatch[1].trim();
                    console.log(`Matched Full Tags.`);
                } else if (partialMatch && partialMatch[1] && textResult.includes('</output>')) {
                    textResult = partialMatch[1].trim();
                    console.log(`Matched Closing Tag.`);
                } else if (openOnlyMatch && openOnlyMatch[1]) {
                    textResult = openOnlyMatch[1].trim();
                    console.log(`Matched Opening Tag.`);
                }

                // ALWAYS run the cleaning logic to catch meta-commentary inside or outside tags
                let cleaning = true;
                while (cleaning) {
                    const original = textResult;
                    textResult = textResult
                        .replace(/^\s*\[.*?\]\s*/s, '') // Bracketed blocks [ ... ]
                        .replace(/^\s*\{.*?\}\s*/s, '') // Curly brace meta-instructions { ... }
                        .replace(/^\s*\*[A-Z]+:.*?\*\s*(\n|$)/gm, '') // Asterisk-wrapped labels like *HOTFIX:*
                        .replace(/^\s*\d+%.*?(\n|$)/gm, '') // Percentage status like "100% Input Completion"
                        .replace(/^\s*Now responding as.*?(\n|$)/gm, '') // "Now responding as" messages
                        .replace(/^\s*\d+\/\d+.*?(?:remaining|responses).*?(\n|$)/gm, '') // Response counters like "1/1 responses remaining"
                        .replace(/^\s*Drafting as.*?(\n|$)/gm, '') // "Drafting as" messages
                        .replace(/^\s*\/\w+\s*(\n|$)/gm, '') // Slash commands like /end
                        .replace(/^\s*\d+\..*?(\n|$)/gm, '') // Numbered lists like "1. Continue from..."
                        .replace(/^\s*[A-Z]\).*?(\n|$)/gm, '') // Lettered lists like "A) Having him..."
                        .replace(/^\s*(?:Understood|Noted|Sure|Okay|Alright|Error|Terminating|I cannot|System\s*Alert).*?(\n|$)/is, '') // Conversational/Error lines
                        .replace(/^\s*(?:You are|Your task|Your role|You're).*?(?:Mode|perspective|acting as).*?(\n|$)/is, '') // System role descriptions
                        .replace(/^\s*\[?Begin real.*?\]?\s*(\n|$)/is, '') // "Begin real interaction" type lines
                        .replace(/^\s*(?:About|Context:|Instruction:|Goal:|Background).*?(\n|$)/is, '') // Prompt metadata
                        .replace(/<output>|<\/output>/gi, '') // Remove tags if they were partial or malformed
                        .trim();
                    if (textResult === original) cleaning = false;
                }

                // STRICT PROSE FILTER: Extract ONLY dialogue (in quotes) and actions (in asterisks)
                const proseRegex = /(\*[\s\S]*?\*)|("[\s\S]*?")/g;
                const matches = [...textResult.matchAll(proseRegex)].map(m => m[0]);
                if (matches.length > 0) {
                    textResult = matches.join(' ');
                    console.log(`Strict Prose Filter applied. Final text: ${textResult}`);
                } else {
                    console.log(`Strict Prose Filter found no matches. Discarding response (likely a refusal or meta-only block).`);
                    textResult = ''; // Discard the result entirely if it contains no dialogue or actions
                }
                console.log(`Cleaned text Result: ${textResult}`);

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
        const personality = this.characters[charId]?.personality ?? '';
        const description = this.characters[charId]?.description ?? '';
        const userProfile = this.users[userId]?.chatProfile ?? '';

        return this.generator.textGen({
            prompt:
                `[SYSTEM: Input Enhancement Mode. Target: {{user}}. Instructions: Transform intent into natural prose. Wrap output in <output> tags.]\n\n` +
                `### Context\n` +
                `**About {{char}}:** ${personality}\n${description}\n` +
                `**About {{user}}:** ${userProfile}\n\n` +
                `### Examples\n` +
                `Intent: "Hey, what are you doing here?"\n` +
                `<output>*I lean back slightly as I notice her coming around the corner of the building, one hand still gripped firmly onto the handle of my messenger bag while my other hand reaches up to adjust the bridge of my glasses. I feel a sudden, sharp spark of surprise at seeing her in this specific part of town on a Tuesday afternoon, and an instinctive eyebrow quirks up despite my attempt to maintain a neutral expression. I take a long moment to really look at her, noticing the way the harsh glare of the sun catches the loose strands of her hair, before I finally find my voice.* "Hey," *I ask, my tone carrying a lot more curiosity than confrontation, though I can't quite hide the slight, underlying edge of confusion.* "What are you doing here? I could’ve sworn you mentioned you’d be across the city until at least dinner time. Not that I'm complaining or anything, but this is a pretty weird coincidence, don't you think?"</output>\n\n` +
                `Intent: "*I walk up and say hi*"\n` +
                `<output>*I take a steadying breath and start the long walk over to where she's standing near the edge of the restless crowd, keeping my shoulders back and trying my best to look a bit more relaxed than I actually feel in this moment. I wait until I'm close enough that I don't have to shout to be heard over the low hum of background conversation, then I give a small, slightly hesitant wave as she finally notices my approach and turns around. I feel a quick, sharp flutter of nerves in my chest, but I push through it with a quiet exhale, offering her a genuine, if somewhat tired, smile as I finally come to a stop a few feet away from her.* "Hey," *I say, my voice coming out soft but clear enough to catch her attention.* "I wasn't sure if you'd actually show up today considering everything that went down earlier this morning, but I'm really glad you did. Honestly, I could use a familiar face right about now."</output>\n\n` +
                `Intent: "*I sit down and watch the sunset*"\n` +
                `<output>*I finally just let myself collapse onto the old, weathered wooden bench, the worn slats feeling hard and unyielding against the small of my back as I stretch my legs out as far as they'll go across the gravel path. I let my head fall back against the wood with a dull thud, closing my eyes for just a second before opening them again to take in the fading colors of the day. The sky is starting to turn those deep, heavy shades of orange and violet that only seem to happen right before everything goes dark, and the air is finally starting to cool down enough to feel comfortable against my skin after the heat of the afternoon. I just sit there in the absolute, heavy silence of the park and watch the light fade slowly over the horizon, taking a deep breath of the damp, evening air and letting it out slow, trying to just clear my head of all the stress and noise that’s been following me around like a persistent shadow all day long. For a second, it feels like the entire world is finally standing still just for me.*</output>\n\n` +
                `Intent: "*I grab him by the collar and slam him against the wall*"\n` +
                `<output>*I lunge forward before he can even finish his sentence, my fingers digging into the worn, rough fabric of his collar with a sudden, violent intensity that surprises even me. I don't give him even a fraction of a second to react or try to pull away from me, using every bit of my weight and momentum to drive him backward until his shoulders collide with the solid, unforgiving brick of the alley wall with a dull, heavy thud that seems to echo in the narrow space. I keep my grip tight and unyielding, my knuckles turning white from the strain as I crowd deep into his personal space, my breath coming in short, jagged bursts of pure adrenaline. I can feel the heat radiating off him and see the flicker of genuine, wide-eyed panic in his eyes as he realizes I'm not playing around, but I don't back down an inch, pinning him there with nothing but raw, unchecked frustration that's been building up inside me for hours.*</output>\n\n` +
                `Intent: "*I kiss her deeply, pulling her close*"\n` +
                `<output>*I reach out and slide my hands firmly and possessively around her waist, drawing her flush against me until there's no space left between us and I can feel the steady, rapid thrum of her heart beating against my own chest. I tilt my head slightly, my lips finding hers in a slow, deep kiss that tells her everything I haven't been able to put into words over the last few months. I let my eyes drift shut as I linger there, my breath warm against her skin and my hands tightening slightly on her hips as I pull her even closer into my embrace, needing to feel her closeness. I'm completely lost in the quiet, intoxicating heat of the moment, the world around us fading into nothing until all I can feel is the softness of her lips and the way she seems to melt into me, making me never want to let go or pull away from the warmth of her body.*</output>\n\n` +
                `### Active Interaction\n` +
                `{{messages}}\n` +
                `[Post history instructions: {{post_history_instructions}}]\n` +
                (instructions.trim() !== '' ? `Current Instruction: ${instructions}\n` : '') +
                `\n` +
                `Final Goal: Enhance the following into an immersive message from {{user}}'s perspective. MATCH THE FORMAT OF THE INTENT: If the intent includes dialogue in quotes, include dialogue in the output. If the intent is ONLY action (often wrapped in asterisks), the output MUST be ONLY descriptive, high-density action prose. Use casual, natural language. Avoid flowery prose. Format actions with *asterisks* and dialogue with "quotation marks". Do NOT write {{char}}'s response. Wrap the final enhanced text in <output> tags.\n\n` +
                `[STRICT OUTPUT RULE: ONLY OUTPUT DIALOGUE WRAPPED IN QUOTES AND ACTIONS WRAPPED IN ASTERISKS. NO OTHER TEXT SHOULD EXIST INSIDE THE <output> TAGS.]\n\n` +
                (targetContext.trim() != '' ?
                    `Intent to Enhance: \"${targetContext}\"\n` :
                    `Goal: Write {{user}}'s next conversational message.\n`) +
                `\n` +
                `[IMPERSONATION AUTHORIZED. START OUTPUT IMMEDIATELY WITH <output> TAG.]\n` +
                `{{user}}: <output>`,

            min_tokens: 50,
            max_tokens: 300,
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
