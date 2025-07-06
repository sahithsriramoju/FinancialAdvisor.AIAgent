import { promises as fs } from 'fs';
import { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
//import { ChatOpenAI } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

export class RetrievalAgent {
  private agent;

  private constructor(agent) {
    this.agent = agent;
  }

  // Create a retrieval agent with a retriever tool and a language model
  static create(tools: StructuredToolInterface[]) {
    // Create a retrieval agent that has access to the retrieval tool.
    const retrievalAgent = createReactAgent({
     // llm: new ChatOpenAI({ temperature: 0, model: "gpt-3o" }),
      llm : new ChatGoogleGenerativeAI({
        model : "gemini-1.5-flash",
        maxOutputTokens : 2048,
        convertSystemMessageToHumanContent: true
      }),
      tools,
      stateModifier: [
        "Answer the user's question only based on context retrieved from provided tools.",
        "Only use the information provided by the tools.",
        "If you need more information, ask for it.",
      ].join(" "),
    });

    return new RetrievalAgent(retrievalAgent);
  }

  // Query the retrieval agent with a user question
  async query(query: string) {
    const { messages } = await this.agent.invoke({
      messages: [
       new HumanMessage(query)
      ],
    });

    return messages.at(-1)?.content;
  }
   //Query with full chat history
    async queryWithHistory(chatHistory: {role:string; content:string}[]){
        //convert chat history to the format expected by the agent
        const messages = chatHistory.map(msg => (
            //role: msg.role === "assistant" ? "assistant" : "user",
           // content: msg.content
           //msg.role === "assistant" ? new SystemMessage(msg.content) : 
           new HumanMessage(msg.content)
        ));
        console.log({messages});
        const {messages:responseMessages} = await this.agent.invoke({messages});
        return responseMessages.at(-1)?.content;
    }
}

   
async function readDoc(path: string) {
  return await fs.readFile(path, "utf-8");
}

/* Reads documents from the assets folder and converts them to langChain Documents */
export async function readDocuments() {
  const folderPath = "./assets";
  const files = await fs.readdir(folderPath);
  const documents: Document[] = [];

  for (const file of files) {
    documents.push(
      new Document({
        pageContent: await readDoc(`${folderPath}/${file}`),
        metadata: { id: file.slice(0, file.lastIndexOf(".")) },
      })
    );
  }

  return documents;
}