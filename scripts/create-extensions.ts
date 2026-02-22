import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  console.log('✅ pg_trgm extension created');
  
  // Verify both extensions
  const result = await client.query(
    "SELECT extname, extversion FROM pg_extension WHERE extname IN ('postgis', 'pg_trgm') ORDER BY extname"
  );
  for (const row of result.rows) {
    console.log(`   ✅ ${row.extname} v${row.extversion}`);
  }
  
  client.release();
  await pool.end();
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
