#!/usr/bin/env bash
set -e

echo "开发打包（含 node_modules）：将源代码 + node_modules 打包进 rincy-dev.tar.gz"
rm -rf rincy-dev.tar.gz

cp -r src/ web/ package.json package-lock.json .env.example start.sh README.md node_modules/ . 2>/dev/null
tar -czf rincy-dev.tar.gz src/ web/ package.json package-lock.json .env.example start.sh README.md node_modules/
echo "开发打包完成: rincy-dev.tar.gz ($(du -sh rincy-dev.tar.gz | cut -d' ' -f1))"
