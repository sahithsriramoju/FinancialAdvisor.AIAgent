import "dotenv/config";
import path from  "path";
import express from "express";
import session from "express-session";
import passport from "passport";
import {default as Auth0Strategy} from "passport-auth0";
//import { OpenAIEmbeddings } from "@langchain/openai";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { FGARetriever } from "@auth0/ai-langchain/RAG";
import { readDocuments, RetrievalAgent } from "./helpers";
import { fileURLToPath } from "url";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";


const __filename = fileURLToPath(import.meta.url);
const  __dirname = path.dirname(__filename);

const auth0Config = {
    domain : process.env.AUTH0_DOMAIN || '',
    clientID :  process.env.AUTH0_CLIENT_ID || '',
    clientSecret : process.env.AUTH0_CLIENT_SECRET || '',
    callbackURL : process.env.AUTH0_CALLBACK_URL || 'http://localhost:3000/callback'
}

//Set up Auth0 strategy
passport.use(
    new Auth0Strategy(auth0Config, (accessToken,refreshToken, extraParams, profile, done)=>{
        return done(null, profile);
    })
);

//Store and retrieve user data in session
passport.serializeUser((user,done)=> done(null,user));
passport.deserializeUser((user,done) => done(null,user as Express.User));

const app = express();
const port = process.env.PORT || 3000;

//setup view engine
app.set("views",path.join(__dirname,"views"));
app.set("view engine","ejs");

//Middleware
app.use(express.static(path.join(__dirname,"public")));
app.use(express.urlencoded({extended:true}));
app.use(express.json());
app.use(session({
    secret: 'fin-advisor-secret',
    resave: false,
    saveUninitialized : false,
    cookie : {maxAge : 60*60*1000}
}));

app.use(passport.initialize());
app.use(passport.session());


//session and user types
declare module 'express-session' {
    interface SessionData {
        chatHistory : {role :string; content: string}[];
        returnTo? : string;
    }
}

//Extend Express User type
declare global {
    namespace Express {
        interface User {
            id?: string;
            displayName?: string;
            user_id?: string;
            sub?: string;
            [key: string]:any;
        }
    }
}

//Get user ID from authenticated user
function getUserId (req: express.Request) : string {
    if(req.user) {
        //Get user ID from Auth0 profile
        return req.user.id || req.user.user_id || req.user.sub || 'anonymous';
    }
    return 'anonymous';
}

//Global variables 
let vectorStore: MemoryVectorStore;

async function initDocuments() {
     // 1. Read and load documents from the assets folder
    const documents = await readDocuments();
    // 2. Create an in-memory vector store from the documents for OpenAI models.
    vectorStore = await MemoryVectorStore.fromDocuments(
        documents,
        new GoogleGenerativeAIEmbeddings({
            modelName : "embedding-001"
        })
        //new OpenAIEmbeddings({ model: "text-embedding-3-small" })
  );
}

// authentication middleware
function requireLogin(req: express.Request, res: express.Response, next: express.NextFunction){
    if(req.isAuthenticated()){
        return next();
    }
    req.session.returnTo = req.originalUrl;
    res.redirect('/login');
}

//auth routes
app.get('/login', passport.authenticate('auth0',{scope: 'openid email profile'}));

app.get('/callback', (req,res,next) => {
    passport.authenticate('auth0',(err,user) => {
        if(err || !user) return res.redirect('/login');
        req.logIn(user,(err) => {
            if(err) return next(err);
            const returnTo = req.session.returnTo || '/';
            delete req.session.returnTo;
            res.redirect(returnTo);
        });
    })(req,res,next);
});

app.get('/logout',(req,res) => {
    req.logout(()=>{
        const returnTo = encodeURIComponent('http://localhost:3000');
        res.redirect(`https://${auth0Config.domain}/v2/logout?client_id=${auth0Config.clientID}&returnTo=${returnTo}`);
    })
})

//Routes
app.get("/",(req,res) => {
    if(!req.session.chatHistory) {
        req.session.chatHistory = [];
    }
    res.render("index" , { 
        chatHistory : req.session.chatHistory,
        user: req.user
    });
});

app.get("/chat",requireLogin, (req,res) => {
    if(!req.session.chatHistory) {
        req.session.chatHistory = [];
    }

    res.render ("index", {
        chatHistory : req.session.chatHistory,
        user : req.user
    });
});

app.post("/ask", requireLogin, async (req,res) => {
    const {question} = req.body;
    if( !req.session.chatHistory){
        req.session.chatHistory = [];
    }

    if(!question) {
        return res.render ("index",{
            error : "Please enter a question",
            chatHistory : req.session.chatHistory,
            user: req.user
        });
    }
    try{
        // get user id for authorization
        const userId = getUserId(req);
        console.log(`Processing request for user: ${userId}`);

       // 3. Create a retriever that uses FGA to gate fetching documents on permissions.
        const retriever = FGARetriever.create({
            retriever: vectorStore.asRetriever(),
            // FGA tuple to query for the user's permissions
            buildQuery: (doc) => ({
            user: `user:${userId}`,
            object: `doc:${doc.metadata.id}`,
            relation: "viewer",
            }),
        });

         // 4. Convert the retriever into a tool for an agent.
        const fgaTool = retriever.asJoinedStringTool();
        // 5. The agent will call the tool, rephrasing the original question and
        // populating the "query" argument, until it can answer the user's question.
        const retrievalAgent = RetrievalAgent.create([fgaTool]);

        // 6. add user message to history
       // req.session.chatHistory.push( {role:"assistant", content : "Hello, I'm your personal financial advisor. Ask me what know insights about your financial spendings"});
        req.session.chatHistory.push( {role:"user", content : question});

        // 7. Query the retrieval agent with a prompt and chat hsitory
        const answer = await retrievalAgent.queryWithHistory(req.session.chatHistory);

        // 8. Add AI response to history
        req.session.chatHistory.push({role:"assistant",content: answer});

        res.render("index", {
            chatHistory : req.session.chatHistory,
            user: req.user
        });
    }
    catch(error){
        console.error("Error querying the AI:",error);
        req.session.chatHistory.push({
            role:"error",
            content: "An error occurred while processing your question"
        });

        res.render("index", {
            chatHistory: req.session.chatHistory,
            user: req.user
        });
    }
});
app.post("/clear", requireLogin , (req,res) => {
    req.session.chatHistory = [];
    res.redirect("/chat");
});

//start the server
(async () => {
    try {
        await initDocuments();
        app.listen(port, () => {
            console.log(`Financial Advisor AI agent running on http://localhost:${port}`);
        });
    }
    catch(error) {
        console.error("Failed to initialize the server:", error);
    }
})();
export default app;