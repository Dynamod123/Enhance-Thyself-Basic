import {ReactElement} from "react";
import {
    StageBase,
    StageResponse,
    InitialData,
    Message,
    AspectRatio,
    Character,
    User
} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";

type MessageStateType = any;
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    readonly ASPECT_RATIO_MAPPING: {[key: string]: AspectRatio} = {
        "Cinematic Horizontal (21:9)": AspectRatio.CINEMATIC_HORIZONTAL,
        "Widescreen Horizontal (16:9)": AspectRatio.WIDESCREEN_HORIZONTAL,
        "Photo Horizontal (3:2)": AspectRatio.PHOTO_HORIZONTAL,
        "Post Horizontal (5:4)": AspectRatio.POST_HORIZONTAL,
        "Square (1:1)": AspectRatio.SQUARE,
        "Post Vertical (4:5)": AspectRatio.POST_VERTICAL,
        "Photo Vertical (2:3)": AspectRatio.PHOTO_VERTICAL,
        "Widescreen Vertical (9:16)": AspectRatio.WIDESCREEN_VERTICAL,
        "Cinematic Vertical (9:21)": AspectRatio.CINEMATIC_VERTICAL
    }
    // Configurable:
    maxLife: number = 10;
    artStyle: string = 'hyperrealistic illustration, dynamic angle, rich lighting';
    aspectRatio: AspectRatio = AspectRatio.WIDESCREEN_HORIZONTAL;

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
        this.maxLife = config?.maxLife ?? this.maxLife;
        this.artStyle = config?.artStyle ?? this.artStyle;
        this.aspectRatio = (config && Object.keys(this.ASPECT_RATIO_MAPPING).includes(config.aspectRatio)) ? this.ASPECT_RATIO_MAPPING[config.aspectRatio] : this.aspectRatio;

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
        const {
            anonymizedId,
            promptForId,
            content} = userMessage;
        let newContent = content;
        let isMain = userMessage.isMain;


        this.longTermLife = Math.max(0, this.longTermLife - 1);
        this.imageInstructions = [];

        const longTermRegex = /\[\[([^\]]*)\]\](?!\()/gm;

        let possibleLongTermInstruction = [...newContent.matchAll(longTermRegex)].map(match => match.slice(1)[0]);

        // Image flags:
        for (let instruction of possibleLongTermInstruction) {
            if (instruction.startsWith("/")) {
                const command = instruction.split(" ")[0];
                console.log(`Process a possible command: ${command} (${instruction})`);
                if (["/imagine", "/image", "/pic", "/picture", "/photo", "/i"].includes(command)) {
                    console.log(`Background imagine command detected: ${instruction.split(command)[1].trim()}`);
                    this.backgroundImageInstruction = instruction.split(command)[1].trim();
                    this.imageInstructions.push(instruction.split(command)[1].trim());
                } else if (["/enhance", "/impersonate", "/imp", "/e"].includes(command)) {
                    // Need to get all non-[] text
                    const targetContext = instruction.split(command)[1];
                    const wholeMatch = `[[${command}${targetContext}]]`;
                    const newHistory = newContent.split(wholeMatch)[0];
                    console.log(`Enhance command detected: ${wholeMatch}`);
                    const result = (await this.enhance(promptForId ?? Object.keys(this.characters)[0], anonymizedId, newHistory.trim(), targetContext.trim()))?.result ?? '';
                    newContent = newContent.replace(wholeMatch, result);
                }
            }
        }

        possibleLongTermInstruction = possibleLongTermInstruction.filter(instruction => !instruction.startsWith("/"));

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

        // Filter all [[]] from content:
        newContent = newContent.replace(longTermRegex, "").trim();


        const currentRegex = /(?<!\[)\[([^\]|\[]*)\](?!\()/gm;
        let currentInstructions = [...newContent.matchAll(currentRegex)].map(match => match.slice(1)[0]);

        // Handle commands:
        for (let instruction of currentInstructions) {
            if (instruction.startsWith("/")) {
                const command = instruction.split(" ")[0];
                console.log(`Process a possible command: ${command} (${instruction})`);
                if (["/imagine", "/image", "/pic", "/picture", "/photo", "/i"].includes(command)) {
                    console.log(`Imagine command detected: ${instruction.split(command)[1].trim()}`);
                    this.imageInstructions.push(instruction.split(command)[1].trim());
                } else if (["/enhance", "/impersonate", "/imp", "/e"].includes(command)) {
                    // Need to get all non-[] text
                    const targetContext = instruction.split(command)[1];
                    const wholeMatch = `[${command}${targetContext}]`;
                    const newHistory = newContent.split(wholeMatch)[0];
                    console.log(`Enhance command detected: ${wholeMatch}`);
                    const result = (await this.enhance(promptForId ?? Object.keys(this.characters)[0], anonymizedId, newHistory.trim(), targetContext.trim()))?.result ?? '';
                    newContent = newContent.replace(wholeMatch, result);
                }
            }
        }
        // Filter all non-Markdown [] from newContent:
        newContent = newContent.replace(currentRegex, "").trim();

        // Remove commands:
        currentInstructions = currentInstructions.filter(instruction => !instruction.startsWith("/"));

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

        const newContent = await this.filterValidMarkdown(botMessage.content);

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
                prompt: 
                    `Purpose: The goal of this task is to digest the context and craft descriptive input for an image generator.\n\n` +
                    `Narrative History:{{messages}}\n\n${instruction.length > 0 ? `Essential Image Context to Convey:\n${instruction}\n\n` : ''}` +
                    `${Object.values(this.characters).map(character => `Information about ${character.name}:\n${character.personality}`).join(`\n\n`)}\n\n` +
                    `${Object.values(this.users).map(user => `Information about ${user.name}:\n${user.chatProfile}`).join(`\n\n`)}\n\n` +
                    `General instruction: {{post_history_instructions}}\n\n` +
                    `Current priority instruction:\nUse this response to synthesize a concise visual description of ${instruction.length > 0 ? `the essential image context` : `the current narrative moment`}. ` +
                    `This system response will be fed directly into an image generator, which is unfamiliar with the names or appearance of characters or settings; ` +
                    `use tags and keywords to convey essential details about the character(s), setting, action, and scene composition, ` +
                    `presenting ample character appearance notes--particularly if they seem obvious: gender, skin tone, hair style/color, physique, outfit, etc.\n\n` +
                    `Sample responses:\n` +
                    `System: Composition: (A man sits across from a woman at a busy cafe, table in frame)\nMan: (white, tall, scrawny, short unkempt dark hair, glasses, business casual attire, arched eyebrow)\nWoman: (tanned, short, curvy, long auburn hair, blouse, slacks, cute smile)\n` +
                    `System: Composition: (A man stands, arms crossed, in a modern living room, waist-up portrait)\nMan: (band tee, hint of a smirk, rolling eyes, graying short light-brown hair, brown eyes, pronounced stuble, broad shoulders, narrow waist, chiseled jaw)` +
                    `System: Composition: (A woman crosses a busy, futuristic city street)\nWoman: (waving excitedly, short shorts, black crop-top, blue hair in a bob, bright smile, willowy build, green eyes)\n\n`,
                min_tokens: 50,
                max_tokens: 180,
                include_history: true
            });
            if (imageDescription?.result) {
                const imagePrompt = this.substitute(`(${this.artStyle}) ${imageDescription.result}`);
                console.log(`Received an image description: ${imagePrompt}`);
                
                const imageResponse = await this.generator.makeImage({
                    aspect_ratio: this.aspectRatio,
                    prompt: imagePrompt
                });
                if (imageResponse?.url) {
                    imageUrls.push(`![](${imageResponse.url})`);
                    // If at some point stages can control displayed versus context content, I'd like to shift to including the image prompt:
                    //imageUrls.push(`![An image generated from this prompt: ${this.sanitizeMarkdownContent(imagePrompt)}](${imageResponse.url})`);
                    if (instruction.trim() != '' && instruction == this.backgroundImageInstruction) {
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
            modifiedMessage: newContent + (imageUrls.length > 0 ? '\n' : '') + imageUrls.join('\n\n'),
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
            const response = await fetch(url, {method: 'HEAD'});
            console.log(`Validating ${url}: ${response.ok}`);
            return response.ok;
        } catch {
            return false;
        }
    }

    enhance(charId: string, userId: string, newHistory: string, targetContext: string) {
        return this.generator.textGen({
            prompt:
                `{{system_prompt}}\n\n` +
                `About {{char}}: ${this.characters[charId].personality}\n${this.characters[charId].description}\n` +
                `About {{user}}: ${this.users[userId].chatProfile}\n\n` +
                `[Begin real interaction.]\n{{messages}}\n` +
                `{{user}}: ${newHistory}\n\n` +
                `General Instruction: [{{post_history_instructions}}]\n\n` +
                `Priority Instruction: [At the System prompt, seamlessly continue the narrative as {{user}}, ` +
                (targetContext.trim() != '' ?
                    `focusing on depicting and enhancing the following intent from {{user}}'s perspective: \"${targetContext}\".\n` :
                    `focusing on depicting {{user}}'s next dialog or actions from their perspective.\n`) +
                `Write as though building directly from {{user}}'s final input above, taking care to maintain the narrative voice and style {{user}} employs while conveying the target intent with superior detail and suitable impact]\n\n`,

            min_tokens: 50,
            max_tokens: 300,
            include_history: true,
        });
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
            'school': 'college',
            'youngster': 'individual',
            'child': 'individual',
            'kid': 'individual',
            'teen ': 'individual ',
            'teenager': 'individual',
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
