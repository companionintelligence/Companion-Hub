FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app .
EXPOSE 3000
CMD ["node", "index.js"]
