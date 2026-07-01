import { pool } from './database.mjs';
async function run() {
    const res = await pool.query("SELECT code, name, logo_name, is_active FROM finance_definitions WHERE type='factory'");
    console.log(res.rows);
    await pool.end();
}
run();
