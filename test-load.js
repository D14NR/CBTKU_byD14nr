// Load testing script (gunakan k6 atau artillery untuk production)
const axios = require('axios');

const API_URL = 'http://localhost:3000/api';
const CONCURRENT_USERS = 50;
const REQUESTS_PER_USER = 20;

async function simulateUser(userId) {
  const user = {
    id: userId,
    username: `testuser${userId}`,
    password: 'password123'
  };
  
  const results = [];
  
  try {
    // 1. Login
    const loginRes = await axios.post(`${API_URL}/login`, {
      u: user.username,
      p: user.password
    });
    
    if (loginRes.data.success) {
      results.push({ step: 'login', success: true });
      
      // 2. Get agendas
      const agendaRes = await axios.get(`${API_URL}/agenda`);
      results.push({ step: 'agenda', success: agendaRes.data.success });
      
      // 3. Simulate random actions
      for (let i = 0; i < REQUESTS_PER_USER; i++) {
        const action = Math.floor(Math.random() * 3);
        
        switch(action) {
          case 0: // Save answer
            await axios.post(`${API_URL}/save-jawaban-chunk`, {
              pid: user.id,
              aid: 1,
              mid: 1,
              chunk_index: Math.floor(Math.random() * 10),
              chunk_data: Array(30).fill().map(() => 
                Math.random() > 0.5 ? 'A' : '-'
              )
            });
            break;
            
          case 1: // Get soal chunk
            await axios.post(`${API_URL}/get-soal-chunked`, {
              agenda_id: 1,
              peserta_id: user.id,
              mapel_id: 1,
              chunk: Math.floor(Math.random() * 5)
            });
            break;
            
          case 2: // Check usage
            await axios.get(`${API_URL}/usage`);
            break;
        }
        
        results.push({ step: `action_${i}`, success: true });
      }
    }
  } catch (error) {
    results.push({ step: 'error', success: false, error: error.message });
  }
  
  return results;
}

async function runLoadTest() {
  console.log(`🚀 Starting load test with ${CONCURRENT_USERS} users...`);
  
  const startTime = Date.now();
  const promises = [];
  
  for (let i = 1; i <= CONCURRENT_USERS; i++) {
    promises.push(simulateUser(i));
    
    // Stagger requests
    if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  const results = await Promise.all(promises);
  const endTime = Date.now();
  
  // Analyze results
  const totalRequests = results.reduce((sum, userResults) => sum + userResults.length, 0);
  const successfulRequests = results.reduce((sum, userResults) => 
    sum + userResults.filter(r => r.success).length, 0
  );
  
  console.log('\n📊 LOAD TEST RESULTS:');
  console.log('====================');
  console.log(`Total Users: ${CONCURRENT_USERS}`);
  console.log(`Total Requests: ${totalRequests}`);
  console.log(`Successful: ${successfulRequests}`);
  console.log(`Failed: ${totalRequests - successfulRequests}`);
  console.log(`Success Rate: ${((successfulRequests / totalRequests) * 100).toFixed(2)}%`);
  console.log(`Total Time: ${((endTime - startTime) / 1000).toFixed(2)}s`);
  console.log(`Requests/sec: ${(totalRequests / ((endTime - startTime) / 1000)).toFixed(2)}`);
  
  // Check for errors
  const errors = results.flatMap(userResults => 
    userResults.filter(r => !r.success && r.error)
  );
  
  if (errors.length > 0) {
    console.log('\n❌ ERRORS:');
    errors.slice(0, 5).forEach(error => {
      console.log(`- ${error.error}`);
    });
  }
}

// Run test
runLoadTest().catch(console.error);
