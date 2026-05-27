FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

FROM node:22-alpine AS runtime
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public/js ./public/js
COPY --from=builder /app/public/output.css ./public/output.css
COPY --from=builder /app/node_modules ./node_modules
COPY public/index.html ./public/index.html
COPY public/input.css ./public/input.css
EXPOSE 3000
CMD ["node", "dist/index.js"]
