import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tailwind.config.cjs');
export default { plugins: { tailwindcss: { config: configPath }, autoprefixer: {} } };
