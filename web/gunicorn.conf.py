# gunicorn 生产配置
# 启动命令：gunicorn -c gunicorn.conf.py app:app

bind            = "127.0.0.1:8000"   # 只监听本地，由 Nginx 对外代理
workers         = 1                   # 单 worker：内存缓存不跨进程，多 worker 会重复拉取
worker_class    = "uvicorn.workers.UvicornWorker"
threads         = 4
worker_connections = 100
timeout         = 180                 # AKShare 首次拉取约 30-60s，需放宽
keepalive       = 5
accesslog       = "-"                 # 输出到 stdout（由 systemd 接管）
errorlog        = "-"
loglevel        = "info"
