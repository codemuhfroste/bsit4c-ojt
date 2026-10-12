import { createApp } from "./app.js";
import { migrate } from "./db.js";

await migrate();
const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => console.log(`http://localhost:${port}`));
