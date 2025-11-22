import { Orq } from "@orq-ai/node";

const client = new Orq({ apiKey: process.env.ORQ_API_KEY! });

async function test() {
    console.log("Testing datasets.list()...");
    const result = await client.datasets.list({ limit: 5 });
    console.log("Type:", typeof result);
    console.log("Constructor:", result?.constructor?.name);
    console.log("Is Array:", Array.isArray(result));
    console.log("Keys:", Object.keys(result || {}));
    
    // Try to iterate
    if (Symbol.asyncIterator in (result as any)) {
        console.log("Has async iterator!");
        const items: any[] = [];
        for await (const item of result as any) {
            items.push(item);
            if (items.length >= 3) break;
        }
        console.log("Items:", JSON.stringify(items, null, 2));
    } else {
        console.log("Result:", JSON.stringify(result, null, 2));
    }
}

test().catch(console.error);
