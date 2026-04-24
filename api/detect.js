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
        let hiveResponse;
        const contentType = req.headers['content-type'] || '';
        
        if (contentType.includes('multipart/form-data')) {
            const formData = await parseMultipartForm(req);
            
            if (!formData.file) {
                return res.status(400).json({ success: false, message: '没有上传文件' });
            }
            
            const form = new FormData();
            const blob = new Blob([formData.file.content], { type: formData.file.type });
            form.append('media', blob, formData.file.name || 'image.jpg');
            
            hiveResponse = await fetch(HIVE_API_URL, {
                method: 'POST',
                headers: {
                    'authorization': `Bearer ${HIVE_SECRET_KEY}`
                },
                body: form
            });
        } else {
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
            
            if (!data.url) {
                return res.status(400).json({ success: false, message: '缺少URL参数' });
            }
            
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
        console.error(error);
        return res.status(500).json({
            success: false,
            message: '服务器内部错误',
            error: error.message
        });
    }
}

async function parseMultipartForm(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    
    const buffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'];
    const boundaryMatch = contentType.match(/boundary=([^;]+)/);
    
    if (!boundaryMatch) {
        throw new Error('缺少 boundary');
    }
    
    const boundary = boundaryMatch[1];
    const parts = buffer.toString('binary').split(`--${boundary}`);
    
    const result = { fields: {}, file: null };
    
    for (let i = 1; i < parts.length - 1; i++) {
        const part = parts[i];
        const headerEnd = part.indexOf('\r\n\r\n');
        
        if (headerEnd === -1) continue;
        
        const headers = part.substring(0, headerEnd);
        const content = part.substring(headerEnd + 4);
        
        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const typeMatch = headers.match(/Content-Type: ([^\r\n]+)/);
        
        if (nameMatch) {
            const name = nameMatch[1];
            
            if (filenameMatch) {
                const fileContent = Buffer.from(content, 'binary');
                fileContent.length = fileContent.length - 2;
                
                result.file = {
                    name: filenameMatch[1],
                    type: typeMatch ? typeMatch[1] : 'image/jpeg',
                    content: fileContent
                };
            } else {
                result.fields[name] = content.trim();
            }
        }
    }
    
    return result;
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
