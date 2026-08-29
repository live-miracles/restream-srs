import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
const version = packageJson.version;

for (const fileName of ['public/index.html', 'public/login.html']) {
    const filePath = path.join(projectDir, fileName);
    const source = fs.readFileSync(filePath, 'utf8');
    const updated = source.replace(/(output\.css\?v=)[^"']+/g, `$1${version}`)
        .replace(/(dashboard-entry\.js\?v=)[^"']+/g, `$1${version}`);

    if (!source.includes('output.css?v=') && !source.includes('dashboard-entry.js?v=')) {
        throw new Error(`No versioned asset reference found in ${fileName}`);
    }

    fs.writeFileSync(filePath, updated);
}
