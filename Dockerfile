FROM node:20-slim

WORKDIR /usr/src/app

# Install deps first so Docker can cache this layer between deploys
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the backend
COPY . .

# Back4App Containers routes traffic to whatever port your app listens on;
# server.js already reads process.env.PORT, and Back4App sets that env var.
EXPOSE 8080

CMD ["node", "server.js"]
