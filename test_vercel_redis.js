// Простой тест - попробуем создать пользователя через API
const https = require('https');

function post(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Headers:', JSON.stringify(res.headers, null, 2));
        console.log('Body:', body);
        resolve({ status: res.statusCode, body });
      });
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function test() {
  console.log('\n=== Testing /api/site?action=login (register) ===\n');
  
  const username = 'verceltest' + Date.now();
  await post('https://hyperfoxchat.vercel.app/api/site?action=login', {
    username,
    password: 'test1234',
    action: 'register'
  });
}

test().catch(console.error);
