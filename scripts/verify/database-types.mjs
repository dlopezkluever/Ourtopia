import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const types = execFileSync(process.execPath, ['node_modules/supabase/dist/supabase.js', 'gen', 'types', 'typescript', '--local'], { encoding: 'utf8' });
writeFileSync('src/lib/supabase/database.types.ts', `${types.split(/\r?\n/).map(line => line.trimEnd()).join('\n').trimEnd()}\n`);
process.stdout.write('Generated database types from the local schema.\n');
