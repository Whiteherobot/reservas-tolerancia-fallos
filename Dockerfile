FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY shared ./shared
COPY services ./services
COPY public ./public
USER node
# Cada servicio de docker-compose elige qué programa correr.
CMD ["node", "services/api-gateway/index.js"]
