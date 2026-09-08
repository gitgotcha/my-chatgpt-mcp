import { DatabaseSync, backup } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
const root=resolve(process.env.LOCALAPPDATA,'ReliableDriveSync');
const path=join(root,'outbox.sqlite');
if(!existsSync(path)){console.log('No V1 outbox');process.exit(0);}
const db=new DatabaseSync(path);
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);
console.log(JSON.stringify({path,tables}));
if(process.argv.includes('--clear')) {
 const allowed=['local_outbox_events','local_outbox_artifacts','identity_cache'];
 if(tables.some(t=>!allowed.includes(t)&&t!=='sqlite_sequence'))throw new Error('unknown_local_table');
 const folder=join(root,'v1-retirement-20260908');mkdirSync(folder,{recursive:true});
 const destination=join(folder,'outbox-before-cleanup.sqlite');
 if(existsSync(destination))throw new Error('backup_already_exists');
 await backup(db,destination);
 db.exec('BEGIN IMMEDIATE');
 try {for(const t of tables.filter(t=>allowed.includes(t)))db.exec(`DELETE FROM "${t}"`);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 console.log(JSON.stringify({cleared:tables.filter(t=>allowed.includes(t)),backup:destination}));
}
db.close();
