@echo off

REM 设置 PATH 为当前目录下的 nodev22 目录
@set "PATH=%~dp0nodev22;%PATH%"

REM 可选：安装依赖
REM npm i

echo Starting ServerJs
REM 如果需要输出请改为 @node server.js
@node server.js

pause
