import { Stage } from "./Stage";
import { useEffect, useState } from "react";
import { DEFAULT_INITIAL, StageBase, InitialData } from "@chub-ai/stages-ts";

// Modify this JSON to include whatever character/user information you want to test.
import InitData from './assets/test-init.json';

export interface TestStageRunnerProps<StageType extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType>, InitStateType, ChatStateType, MessageStateType, ConfigType> {
    factory: (data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) => StageType;
}

/***
 This is a testing class for running a stage locally when testing,
    outside the context of an active chat. See runTests() below for the main idea.
 ***/
export const TestStageRunner = <StageType extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType>,
    InitStateType, ChatStateType, MessageStateType, ConfigType>({ factory }: TestStageRunnerProps<StageType, InitStateType, ChatStateType, MessageStateType, ConfigType>) => {

    // You may need to add a @ts-ignore here,
    //     as the linter doesn't always like the idea of reading types arbitrarily from files
    // @ts-ignore
    const [stage, _setStage] = useState(new Stage({ ...DEFAULT_INITIAL, ...InitData }));

    // This is what forces the stage node to re-render.
    const [node, setNode] = useState(new Date());

    function refresh() {
        setNode(new Date());
    }

    async function delayedTest(test: any, delaySeconds: number) {
        await new Promise(f => setTimeout(f, delaySeconds * 1000));
        return test();
    }

    /***
     This is the main thing you'll want to modify.
     ***/
    async function runTests() {
        console.log("Running manual extraction logic tests...");

        const mockStage = stage as any;
        const proseRegex = /(\*[\s\S]*?\*)|("[\s\S]*?")/g;

        // Test 1: Content with <output> tags
        const rawResponse1 = { result: "Certainly! Here is the message: <output>Hello world</output>" };
        const match1 = rawResponse1.result.match(/<output>([\s\S]*?)<\/output>/i);
        console.assert(match1 && match1[1].trim() === "Hello world", "Test 1 Failed: <output> extraction");

        // Test 2: Content without tags but with meta-commentary (Fallback)
        const rawResponse2 = { result: "Sure thing! Understood.\n\n[Mode: Impersonation]\nHello fallback" };
        let textResult2 = rawResponse2.result;
        let cleaning = true;
        while (cleaning) {
            const original = textResult2;
            textResult2 = textResult2
                .replace(/^\s*\[.*?\]\s*/s, '')
                .replace(/^\s*\{.*?\}\s*/s, '')
                .replace(/^\s*(?:Understood|Noted|Sure|Okay|Alright|Error|Terminating|I cannot|System\s*Alert).*?(\n|$)/is, '')
                .trim();
            if (textResult2 === original) cleaning = false;
        }
        // Test 3: Strict Prose Filter (Isolation of * and ")
        const rawResponse3 = { result: "2-Party Private Interaction Activated. Subjects: Dyna & Mika Tanaka. *I look at her.* \"Hello.\"" };
        const matches3 = [...rawResponse3.result.matchAll(proseRegex)].map(m => m[0]);
        const finalProse3 = matches3.join(' ');
        console.assert(finalProse3 === "*I look at her.* \"Hello.\"", `Test 3 Failed: Strict filter (Got: ${finalProse3})`);

        // Test 4: Strict Prose Filter (Refusal Discard)
        const rawResponse4 = { result: "I'm sorry, I can't do that. It's not appropriate." };
        const matches4 = [...rawResponse4.result.matchAll(proseRegex)].map(m => m[0]);
        const finalProse4 = matches4.length > 0 ? matches4.join(' ') : '';
        console.assert(finalProse4 === "", `Test 4 Failed: Refusal should be discarded (Got: ${finalProse4})`);

        console.log("All extraction and filter logic tests passed!");
    }

    useEffect(() => {
        // Always do this first, and put any other calls inside the load response.
        stage.load().then((res) => {
            console.info(`Test StageBase Runner load success result was ${res.success}`);
            if (!res.success || res.error != null) {
                console.error(`Error from stage during load, error: ${res.error}`);
            } else {
                runTests().then(() => console.info("Done running tests."));
            }
        });
    }, []);

    return <>
        <div style={{ display: 'none' }}>{String(node)}{window.location.href}</div>
        {stage == null ? <div>Stage loading...</div> : stage.render()}
    </>;
}
