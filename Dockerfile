FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# 先装依赖，利用层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --cache /tmp/.npm-cache && rm -rf /tmp/.npm-cache

# 再拷源码
COPY src ./src

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
