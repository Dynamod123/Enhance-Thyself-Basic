import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";

type MessageStateType = any;
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {

    // Configurable:
    maxLife: number = 10;

    // Per-message state:
    longTermInstruction: string = '';
    longTermLife: number = 0;


    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);

        const {config, messageState} = data;
        this.maxLife = config.maxLife ?? this.maxLife;

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
    }

    readMessageState(state: MessageStateType) {
        this.longTermInstruction = state?.longTermInstruction ?? '';
        this.longTermLife = state?.longTermLife ?? 0;
    }

    writeMessageState() {
        return {
            longTermInstruction: this.longTermInstruction,
            longTermLife: this.longTermLife
        }
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const {content} = userMessage;
        let newContent = content;

        this.longTermLife = Math.max(0, this.longTermLife - 1);

        const longTermRegex = /\[\[([^\]]*)\]\](?!\()/gm;
        const possibleLongTermInstruction = [...newContent.matchAll(longTermRegex)].map(match => match.slice(1)).join('\n').trim();
        if (longTermRegex.test(newContent)) {
            if (this.longTermLife > 0) {
                if (possibleLongTermInstruction.length > 0) {
                console.log(`Replacing long-term instruction:\n${this.longTermInstruction}\nWith:\n${possibleLongTermInstruction}`);
                } else {
                    console.log(`Clearing long-term instruction.`);
                }
            } else if (possibleLongTermInstruction.length > 0) {
                console.log(`Setting long-term instruction:\n${possibleLongTermInstruction}`);
            } else {
                console.log(`No current long-term instruction to clear.`);
            }
            this.longTermInstruction = possibleLongTermInstruction;
            this.longTermLife = possibleLongTermInstruction.length > 0 ? this.maxLife : 0;
            newContent = newContent.replace(longTermRegex, "").trim();
        }

        const currentRegex = /\[([^\]]*)\](?!\()/gm;
        const currentInstruction = [...newContent.matchAll(currentRegex)].map(match => match.slice(1)).join('\n').trim();
        newContent = newContent.replace(currentRegex, "").trim();

        const stageDirections = 
                ((this.longTermInstruction.length > 0 && this.longTermLife > 0) ? `Ongoing Instruction: ${this.longTermInstruction}\n` : '') +
                (currentInstruction.length > 0 ? `Critical Instruction: ${currentInstruction}\n` : '');

        // Preserve empty responses that only had instruction.
        if (newContent !== content && newContent.length == 0) {
            newContent = ' ';
        }

        let messageState = this.writeMessageState();

        if (stageDirections.length > 0) {
            console.log(`Sending stage directions:\n${stageDirections}`);
        }

        return {
            stageDirections: stageDirections.length > 0 ? stageDirections : null,
            messageState: messageState,
            modifiedMessage: newContent,
            systemMessage: null,
            error: null,
            chatState: null,
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {

        const {content} = botMessage;
        let newContent = content;

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
        }

        let messageState = this.writeMessageState();

        return {
            stageDirections: null,
            messageState: messageState,
            modifiedMessage: newContent,
            error: null,
            systemMessage: null,
            chatState: null
        };
    }

    render(): ReactElement {
        return <></>
    }

}
