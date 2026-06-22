FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app .
CMD ["node", "index.js"]
