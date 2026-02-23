import fs from "fs";
import path from "path";

const dir = "/Users/kunalbrahma/Desktop/blueprint-mcp/src/tools";
const files = fs.readdirSync(dir).filter(f => f.endsWith(".ts"));

const emojiMap: Record<string, string> = {
    "✅": "[SUCCESS]",
    "❌": "[ERROR]",
    "⚠️": "[WARNING]",
    "📦": "[INFO]",
    "🔌": "[INFO]",
    "💡": "[INFO]",
    "⚡": "[INFO]"
};

for (const file of files) {
    const filePath = path.join(dir, file);
    let content = fs.readFileSync(filePath, "utf-8");
    let modified = false;

    for (const [emoji, replacement] of Object.entries(emojiMap)) {
        if (content.includes(emoji)) {
            content = content.replace(new RegExp(emoji, "g"), replacement);
            modified = true;
        }
    }

    if (modified) {
        fs.writeFileSync(filePath, content, "utf-8");
        console.log(`Updated emojis in ${file}`);
    }
}
