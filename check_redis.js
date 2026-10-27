const { createClient } = require('redis');

async function test() {
  const url =
    process.env.HFC_REDIS_REDIS_URL ||
    process.env.HFC_REDIS_KV_URL ||
    process.env.HFC_REDIS_URL ||
    process.env.REDIS_URL;
  console.log('Redis URL:', url ? 'SET' : 'NOT SET');
  
  if (!url) {
    console.log('No Redis URL found in environment');
    process.exit(1);
  }
  
  const client = createClient({ url });
  
  client.on('error', (err) => {
    console.error('Redis Error:', err.message);
  });
  
  try {
    await client.connect();
    console.log('✅ Redis connected successfully');
    
    await client.set('test_key', 'test_value');
    const val = await client.get('test_key');
    console.log('✅ Redis read/write works:', val);
    
    await client.disconnect();
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
    process.exit(1);
  }
}

test();
