@echo off
rem 计划任务 qq-bridge-memory-collector 的入口：每 5 分钟把 state\qq-memory.log 采进 dsh-qq-extras 的归档库。
rem 手动等价命令：node scripts\qq-extras-collector.mjs（加 --status 看归档现状）。
rem 日志由 node 侧写（--task-log，保留最后 5000 行），这里不重定向：少一层引号/换行坑。
rem 注意：本文件必须保持 CRLF（见 .gitattributes 的 *.bat 规则），LF 会让 cmd 把参数读错。
setlocal
node "%~dp0qq-extras-collector.mjs" --quiet --task-log "%~dp0..\state\qq-extras-collector.log"
exit /b %ERRORLEVEL%