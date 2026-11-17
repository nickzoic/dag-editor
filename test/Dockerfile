FROM node:lts-alpine
RUN apk add chromium
WORKDIR /app
RUN npm install -g npm
COPY package.json package-lock.json ./
RUN npm install
COPY dag-editor.js dag-editor.css dag-editor-demo.html ./
COPY test/unit/ test/unit/
COPY test/browser/ test/browser/
COPY test/helpers/ test/helpers/
COPY test/run.js test/
CMD npm test
