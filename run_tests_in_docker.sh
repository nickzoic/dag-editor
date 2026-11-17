#!/bin/bash
docker build -f test/Dockerfile -t dag-editor-test .
docker run --rm dag-editor-test:latest $*
