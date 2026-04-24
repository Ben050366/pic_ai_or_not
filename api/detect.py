from http.server import HTTPServer, SimpleHTTPRequestHandler
import requests
import json
import os
from http.server import BaseHTTPRequestHandler
import io
import time

HIVE_SECRET_KEY = os.environ.get('HIVE_SECRET_KEY', '6XRi12JquRoMFWJXC02tpw==')
HIVE_API_URL = 'https://api.thehive.ai/api/v3/hive/ai-generated-and-deepfake-content-detection'
MAX_REQUESTS_PER_IP = 10

# 简单的 IP 限制存储
ip_usage = {}

def get_client_ip(request):
    ip = request.headers.get('x-forwarded-for', request.headers.get('x-real-ip', 'unknown'))
    if ',' in ip:
        ip = ip.split(',')[0].strip()
    return ip

def get_usage_info(ip):
    now = time.time()
    one_day = 24 * 60 * 60
    
    if ip not in ip_usage:
        ip_usage[ip] = {'count': 0, 'reset_time': now + one_day}
    
    usage = ip_usage[ip]
    
    if now > usage['reset_time']:
        usage['count'] = 0
        usage['reset_time'] = now + one_day
    
    return {
        'used': usage['count'],
        'max': MAX_REQUESTS_PER_IP,
        'remaining': MAX_REQUESTS_PER_IP - usage['count']
    }

def increment_usage(ip):
    if ip in ip_usage:
        ip_usage[ip]['count'] += 1

class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def do_GET(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        
        client_ip = get_client_ip(self)
        usage = get_usage_info(client_ip)
        
        response = {
            'success': True,
            **usage
        }
        self.wfile.write(json.dumps(response).encode())
    
    def do_POST(self):
        client_ip = get_client_ip(self)
        usage = get_usage_info(client_ip)
        
        if usage['remaining'] <= 0:
            self.send_response(429)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = {
                'success': False,
                'message': '今日使用次数已达上限，请明天再试！',
                **usage
            }
            self.wfile.write(json.dumps(response).encode())
            return
        
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            content_type = self.headers.get('Content-Type', '')
            
            # 读取原始数据
            raw_data = self.rfile.read(content_length)
            
            # 转发给 HIVE
            headers = {
                'authorization': f'Bearer {HIVE_SECRET_KEY}'
            }
            if content_type:
                headers['Content-Type'] = content_type
            
            hive_response = requests.post(
                HIVE_API_URL,
                headers=headers,
                data=raw_data
            )
            
            if not hive_response.ok:
                self.send_response(hive_response.status_code)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                response = {
                    'success': False,
                    'message': 'HIVE API调用失败',
                    'error': hive_response.json()
                }
                self.wfile.write(json.dumps(response).encode())
                return
            
            increment_usage(client_ip)
            hive_result = hive_response.json()
            
            # 返回结果
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            
            response = {
                'success': True,
                'raw': hive_result,
                **get_usage_info(client_ip)
            }
            self.wfile.write(json.dumps(response).encode())
            
        except Exception as e:
            print(f'ERROR: {e}')
            self.send_response(500)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            response = {
                'success': False,
                'message': '服务器内部错误',
                'error': str(e)
            }
            self.wfile.write(json.dumps(response).encode())
