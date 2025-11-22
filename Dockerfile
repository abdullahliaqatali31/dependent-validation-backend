FROM node:18-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY env.example ./

EXPOSE 3000 3001 3002

CMD ["npm", "run", "api"]