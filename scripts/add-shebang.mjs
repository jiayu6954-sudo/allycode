/**
 * Prepend #!/usr/bin/env node to dist/index.js so it can be
 * executed directly via npx or as a global bin (chmod +x on Unix).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distFile = join(__dirname, "..", "dist", "index.js");

const content = readFileSync(distFile, "utf-8");
if (!content.startsWith("#!/usr/bin/env node")) {
  writeFileSync(distFile, "#!/usr/bin/env node\n" + content, "utf-8");
  console.log("✓ Shebang added to dist/index.js");
} else {
  console.log("✓ Shebang already present");
}
