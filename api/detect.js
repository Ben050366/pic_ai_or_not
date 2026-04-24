const HIVE_API_URL = 'https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection';
const HIVE_SECRET_KEY = process.env.HIVE_SECRET_KEY || '6XRi12JquRoMFWJXC02tpw==';
const MAX_REQUESTS_PER_IP = 10;

const ipUsage = new Map();

function getClientIp(req) {
    let ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
    if (Array.isArray(ip)) ip = ip[0];
    if (typeof ip === 'string') ip = ip.split(',')[0].trim();
    return ip;
}

function getUsageInfo(ip) {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    
    let usage = ipUsage.get(ip);
    if (!usage) {
        usage = { count: 0, resetTime: now + oneDayMs };
        ipUsage.set(ip, usage);
    }
    
    if (now > usage.resetTime) {
        usage.count = 0;
        usage.resetTime = now + oneDayMs;
    }
    
    return {
        used: usage.count,
        max: MAX_REQUESTS_PER_IP,
        remaining: MAX_REQUESTS_PER_IP - usage.count
    };
}

function incrementUsage(ip) {
    const usage = ipUsage.get(ip);
    if (usage) {
        usage.count++;
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    const clientIp = getClientIp(req);
    const usageInfo = getUsageInfo(clientIp);
    
    if (req.method === 'GET') {
        return res.json({
            success: true,
            ...usageInfo
        });
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: '方法不允许' });
    }
    
    if (usageInfo.remaining <= 0) {
        return res.status(429).json({ 
            success: false, 
            message: '今日使用次数已达上限，请明天再试！',
            ...usageInfo
        });
    }

    try {
        let body = '';
        if (typeof req.body === 'string') {
            body = req.body;
        } else if (req.body) {
            body = JSON.stringify(req.body);
        } else {
            for await (const chunk of req) {
                body += chunk;
            }
        }
        
        const data = JSON.parse(body);
        let hiveResponse;
        
        if (data.url) {
            hiveResponse = await fetch(HIVE_API_URL, {
                method: 'POST',
                headers: {
                    'authorization': `Bearer ${HIVE_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    input: [{
                        media_url: data.url
                    }]
                })
            });
        } else if (data.base64) {
            const imageBuffer = Buffer.from(data.base64, 'base64');
            const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
            
            const formData = new FormData();
            formData.append('media', blob, 'image.jpg');
            
            hiveResponse = await fetch(HIVE_API_URL, {
                method: 'POST',
                headers: {
                    'authorization': `Bearer ${HIVE_SECRET_KEY}`
                },
                body: formData
            });
        } else {
            return res.status(400).json({ 
                success: false, 
                message: '缺少参数：需要 url 或 base64' 
            });
        }
        
        const result = await hiveResponse.json();
        
        if (!hiveResponse.ok) {
            return res.status(hiveResponse.status).json({
                success: false,
                message: 'HIVE API调用失败',
                error: result
            });
        }
        
        incrementUsage(clientIp);
        const processedData = processHiveResponse(result);
        
        return res.json({
            success: true,
            data: processedData,
            raw: result,
            ...getUsageInfo(clientIp)
        });
    } catch (error) {
        console.error('ERROR:', error);
        return res.status(500).json({
            success: false,
            message: '服务器内部错误',
            error: error.message
        });
    }
}

function processHiveResponse(result) {
    if (!result.output || !result.output.length) {
        return {};
    }
    
    const output = result.output[0];
    const classes = output.classes || [];
    
    const classMap = {};
    classes.forEach(cls => {
        classMap[cls.class] = cls.score;
    });
    
    const generators = [];
    const generatorPrefixes = ['midjourney', 'stable_diffusion', 'stable_diffusion_xl', 'dalle', 
                               'ideogram', 'leonardo', 'bing_image_creator', 'adobe_firefly', 
                               'flux', 'flux2', 'qwen', 'other_image_generators'];
    
    for (const cls of classes) {
        if (generatorPrefixes.includes(cls.class) && cls.score > 0.01) {
            generators.push({ name: cls.class, score: cls.score });
        }
    }
    
    generators.sort((a, b) => b.score - a.score);
    
    const ai_generated = classMap.ai_generated || 0;
    const deepfake = classMap.deepfake || 0;
    
    return {
        ai_generated: ai_generated,
        not_ai_generated: classMap.not_ai_generated || 0,
        deepfake: deepfake,
        ai_generated_audio: classMap.ai_generated_audio || 0,
        not_ai_generated_audio: classMap.not_ai_generated_audio || 0,
        is_ai_generated: ai_generated >= 0.9,
        is_deepfake: deepfake >= 0.9,
        generators: generators.slice(0, 5)
    };
}
