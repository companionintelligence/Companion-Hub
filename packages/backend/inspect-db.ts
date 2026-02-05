import { Client } from 'pg';

const client = new Client({
  user: 'tipi',
  host: 'localhost',
  database: 'tipi',
  password: 'postgres',
  port: 6543,
});

async function main() {
  await client.connect();
  
  console.log('--- All Apps ---');
  const res = await client.query("SELECT * FROM app ORDER BY \"updatedAt\" DESC LIMIT 5");
  
  for (const app of res.rows) {
      console.log(`\nName: ${app.app_name} (ID: ${app.id})`);
      console.log('Exposed Local:', app.exposed_local);
      console.log('Local Subdomain:', app.local_subdomain);
      console.log('Internal Port:', app.port);
      console.log('Config:', JSON.stringify(app.config, null, 2));
  }

  await client.end();
}

main();
