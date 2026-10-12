// Vercel entrypoint: every request that is not a static file is rewritten here (see vercel.json).
import { createApp } from "../src/app.js";

export default createApp();
