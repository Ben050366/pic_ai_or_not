const HIVE_API_URL = 'https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection';
const HIVE_SECRET_KEY = process.env.HIVE_SECRET_KEY || '6XRi12JquRoMFWJXC02tpw==';
const MAX_REQUESTS_PER_IP = 10;

const ipUsage = new Map();

function getClientIp(req) {
    let ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
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

export const config = {
    api: {
        bodyParser: false,
    },
};

export default async function handler(req, res) {
    // 设置 CORS
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
        // 读取原始请求体（和 Python proxy-server.py 一样！）
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const rawData = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        
        // 转发给 HIVE
        const fetchOptions = {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${HIVE_SECRET_KEY}`
            },
            body: rawData
        };
        
        if (contentType) {
            fetchOptions.headers['Content-Type'] = contentType;
        }
        
        const hiveResponse = await fetch(HIVE_API_URL, fetchOptions);
        const resultData = await hiveResponse.json();
        
        if (!hiveResponse.ok) {
            return res.status(hiveResponse.status).json({
                success: false,
                message: 'HIVE API调用失败',
                error: resultData
            });
        }
        
        incrementUsage(clientIp);
        
        return res.json({
            success: true,
            raw: resultData,
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
