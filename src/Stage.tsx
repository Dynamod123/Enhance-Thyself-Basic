import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message, AspectRatio, Character, User} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";

type MessageStateType = any;
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    // Configurable:
    maxLife: number = 10;
    artStyle: string = 'hyperrealistic illustration, dynamic angle, pleasing lighting';

    // Per-message state:
    longTermInstruction: string = '';
    longTermLife: number = 0;
    imageInstructions: string[] = [];
    backgroundImageInstruction: string = '';
    backgroundUrl: string = '';

    // Unsaved:
    characters: {[key: string]: Character};
    users: {[key: string]: User};

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const {
            characters,
            users,
        } = data;

        this.characters = characters;
        this.users = users;

        const {config, messageState} = data;
        this.maxLife = config.maxLife ?? this.maxLife;
        this.artStyle = config.artStyle ?? this.artStyle;

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
        await this.messenger.updateEnvironment({background: this.backgroundUrl ?? ''});
    }

    readMessageState(state: MessageStateType) {
        this.longTermInstruction = state?.longTermInstruction ?? '';
        this.longTermLife = state?.longTermLife ?? 0;
        this.imageInstructions = state?.imageInstructions ?? [];
        this.backgroundImageInstruction = state?.backgroundImageInstruction ?? '';
        this.backgroundUrl = state?.backgroundUrl ?? '';
    }

    writeMessageState() {
        return {
            longTermInstruction: this.longTermInstruction,
            longTermLife: this.longTermLife,
            imageInstructions: this.imageInstructions,
            backgroundImageInstruction: this.backgroundImageInstruction,
            backgroundUrl: this.backgroundUrl
        }
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const {content} = userMessage;
        let newContent = content;

        this.longTermLife = Math.max(0, this.longTermLife - 1);
        this.imageInstructions = [];

        const longTermRegex = /\[\[([^\]]*)\]\](?!\()/gm;
        let possibleLongTermInstruction = [...newContent.matchAll(longTermRegex)].map(match => match.slice(1)[0]);

        // Image flags:
        possibleLongTermInstruction.forEach(instruction => {
            if (instruction.startsWith("/imagine")) {
                console.log(`Background /imagine detected: ${instruction.split("/imagine")[1].trim()}`);
                this.backgroundImageInstruction = instruction.split("/imagine")[1].trim();
                this.imageInstructions.push(this.backgroundImageInstruction);
            }
        });
        possibleLongTermInstruction = possibleLongTermInstruction.filter(instruction => !instruction.startsWith("/imagine"));

        const longTermInstruction = possibleLongTermInstruction.join('\n').trim();
        if (possibleLongTermInstruction.length > 0) {
            if (this.longTermLife > 0) {
                if (longTermInstruction.length > 0) {
                    console.log(`Replacing long-term instruction:\n${this.longTermInstruction}\nWith:\n${longTermInstruction}`);
                } else {
                    console.log(`Clearing long-term instruction.`);
                }
            } else if (longTermInstruction.length > 0) {
                console.log(`Setting long-term instruction:\n${longTermInstruction}`);
            } else {
                console.log(`No current long-term instruction to clear.`);
            }
            this.longTermInstruction = longTermInstruction;
            this.longTermLife = possibleLongTermInstruction.length > 0 ? this.maxLife : 0;
        }
        newContent = newContent.replace(longTermRegex, "").trim();

        const currentRegex = /\[([^\]]*)\](?!\()/gm;
        let currentInstructions = [...newContent.matchAll(currentRegex)].map(match => match.slice(1)[0]);
        newContent = newContent.replace(currentRegex, "").trim();

        // Image flags:
        currentInstructions.forEach(instruction => {
            if (instruction.startsWith("/imagine")) {
                console.log(`/imagine detected: ${instruction.split("/imagine")[1].trim()}`);
                this.imageInstructions.push(instruction.split("/imagine")[1].trim());
            }
        });
        currentInstructions = currentInstructions.filter(instruction => !instruction.startsWith("/imagine"));

        const stageDirections = 
                ((this.longTermInstruction.length > 0 && this.longTermLife > 0) ? `Ongoing Instruction: ${this.longTermInstruction}\n` : '') +
                (currentInstructions.length > 0 ? `Critical Instruction: ${currentInstructions.join('\n').trim()}\n` : '');

        // Preserve empty responses that only had instruction.
        if (newContent !== content && newContent.length == 0) {
            newContent = ' ';
        }

        if (stageDirections.length > 0) {
            console.log(`Sending stage directions:\n${stageDirections}`);
        }

        return {
            stageDirections: stageDirections.length > 0 ? stageDirections : null,
            messageState: this.writeMessageState(),
            modifiedMessage: newContent,
            systemMessage: null,
            error: null,
            chatState: null,
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const {
            anonymizedId,
            promptForId,
            content} = botMessage;

        console.log(`anonymizedId: ${anonymizedId}, promptForId: ${promptForId}`);
        let newContent = content;

        // Strip out markdown that it has attempted to mimic.
        newContent = newContent.replace(/!\[.*?\]\(.*?\)/g, '');
        newContent = newContent.replace(/\[.*?\]\(.*?\)/g, '');

        /*
        const longTermRegex = /\[\[([^\]]+)\]\](?!\()/gm;
        const possibleLongTermInstruction = [...newContent.matchAll(longTermRegex)].map(match => match.slice(1)).join('\n').trim();
        if (possibleLongTermInstruction.length > 0) {
            if (this.longTermLife > 0) {
                console.log(`Response is replacing long-term instruction:\n${this.longTermInstruction}\nWith:\n${possibleLongTermInstruction}`);
            } else {
                console.log(`Response is setting long-term instruction:\n${possibleLongTermInstruction}`);
            }
            this.longTermInstruction = possibleLongTermInstruction;
            this.longTermLife = this.maxLife;
            newContent = newContent.replace(longTermRegex, "").trim();
        }*/

        let imageUrls = [];
        for (let instruction of this.imageInstructions) {
            console.log(`Generate an image with additional instruction: ${instruction}`);
            const imageDescription = await this.generator.textGen({
                prompt: `Information about {{char}}:\n${this.characters[promptForId ?? Object.keys(this.characters)[0]].description}\n\n` +
                    `Information about {{user}}:\n${this.users[promptForId ?? Object.keys(this.users)[0]]}}}\n\n` +
                    `Narrative History:\n{{messages}}\n\n${instruction.length > 0 ? `Essential Image Context to Convey:\n${instruction}\n\n` : ''}` +
                    `Current instruction:\nUse this response to synthesize a concise visual description of ${instruction.length > 0 ? `the essential image context` : `of the current narrative moment`}. ` +
                    `This response will be fed directly into an image generator, so choose tags and keywords that convey great detail about the setting, action, and scene composition, ` +
                    `presenting ample character appearance notes (gender, skin tone, hair style/color, physique, outfit, etc.).`,
                min_tokens: 50,
                max_tokens: 100,
                include_history: true
            });
            if (imageDescription?.result) {
                const imagePrompt = this.substitute(`(${this.artStyle}) ${imageDescription.result}`);
                console.log(`Received an image description: ${imagePrompt}`);
                
                const imageResponse = await this.generator.makeImage({
                    aspect_ratio: AspectRatio.WIDESCREEN_HORIZONTAL,
                    prompt: imagePrompt
                });
                if (imageResponse?.url) {
                    imageUrls.push(`![${this.sanitizeMarkdownContent(imagePrompt)}](${imageResponse.url})`); 
                    if (instruction == this.backgroundImageInstruction) {
                        this.backgroundUrl = imageResponse.url;
                        await this.messenger.updateEnvironment({background: this.backgroundUrl});
                    }
                } else {
                    console.log('Failed to generate an image.');
                }
            } else {
                console.log('Failed to generate an image description.');
            }
        }

        return {
            stageDirections: null,
            messageState: this.writeMessageState(),
            modifiedMessage: imageUrls.join('\n\n') + (imageUrls.length > 0 ? '\n\n' : '') + newContent,
            error: null,
            systemMessage: null,
            chatState: null
        };
    }

    // Replace trigger words with less triggering words, so image gen isn't abetting.
    substitute(input: string) {
        const synonyms: {[key: string]: string} = {
            'old-school': 'retro',
            'old school': 'retro',
            'oldschool': 'retro',
            'schoolgirl': 'college girl',
            'school girl': 'college girl',
            'schoolboy': 'college guy',
            'school boy': 'college guy',
            'youngster': 'individual',
            'child': 'individual',
            'kid': 'individual',
            'young ': ' '
        }
        const regex = new RegExp(Object.keys(synonyms).join('|'), 'gi');

        return input.replace(regex, (match) => {
            const synonym = synonyms[match.toLowerCase()];
            return match[0] === match[0].toUpperCase()
                ? synonym.charAt(0).toUpperCase() + synonym.slice(1)
                : synonym;
        });
    }

    sanitizeMarkdownContent(content: string): string {
        return content.replace(/[\]\(\)\n]/g, '');
    }

    render(): ReactElement {
        return <></>
    }

}
