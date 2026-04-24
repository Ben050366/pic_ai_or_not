const axios = require('axios');

const HIVE_SECRET_KEY = process.env.HIVE_SECRET_KEY || '6XRi12JquRoMFWJXC02tpw==';
const HIVE_API_ENDPOINT = 'https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection';

const ipCounter = new Map();
const MAX_REQUESTS_PER_IP = 10;

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         req.headers['x-real-ip'] ||
         'unknown';
}

function parseHiveResult(result) {
  if (!result || !result.output || !result.output[0]) {
    return null;
  }

  const classes = result.output[0].classes;
  
  const aiGenerated = classes.find(c => c.class === 'ai_generated');
  const notAiGenerated = classes.find(c => c.class === 'not_ai_generated');
  const deepfake = classes.find(c => c.class === 'deepfake');
  
  const generators = [];
  const generatorNames = {
    'midjourney': 'Midjourney',
    'stable_diffusion': 'Stable Diffusion',
    'stable_diffusion_xl': 'Stable Diffusion XL',
    'dalle': 'DALL-E',
    'other_image_generators': '其他AI工具'
  };
  
  for (const cls of classes) {
    if (generatorNames[cls.class] && cls.value > 0.01) {
      generators.push({ 
        name: generatorNames[cls.class], 
        score: cls.value 
      });
    }
  }
  generators.sort((a, b) => b.score - a.score);

  return {
    ai_generated: aiGenerated ? aiGenerated.value : 0,
    not_ai_generated: notAiGenerated ? notAiGenerated.value : 0,
    deepfake: deepfake ? deepfake.value : 0,
    is_ai_generated: aiGenerated ? aiGenerated.value >= 0.9 : false,
    is_deepfake: deepfake ? deepfake.value >= 0.9 : false,
    generators: generators.slice(0, 3)
  };
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const ip = getClientIp(req);
    const count = ipCounter.get(ip) || 0;
    return res.json({
      success: true,
      used: count,
      max: MAX_REQUESTS_PER_IP,
      remaining: MAX_REQUESTS_PER_IP - count
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const ip = getClientIp(req);
  const count = ipCounter.get(ip) || 0;
  
  if (count >= MAX_REQUESTS_PER_IP) {
    return res.status(429).json({
      success: false,
      message: `已达到限制：每个IP最多使用 ${MAX_REQUESTS_PER_IP} 次检测`
    });
  }

  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ success: false, message: '请提供图片URL' });
    }

    const response = await axios.post(HIVE_API_ENDPOINT, {
      input: [{ media_url: url }]
    }, {
      headers: {
        'authorization': `Bearer ${HIVE_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    ipCounter.set(ip, count + 1);

    const parsedResult = parseHiveResult(response.data);
    
    res.json({
      success: true,
      data: parsedResult,
      raw: response.data
    });

  } catch (error) {
    console.error('API Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: '检测失败，请稍后重试'
    });
  }
};
