# syntax=docker/dockerfile:1

FROM golang:alpine AS builder

LABEL stage=builder

ENV CGO_ENABLED 0
ENV GOOS linux
ENV GOPROXY https://goproxy.cn,direct

WORKDIR /build

COPY . .
RUN go mod download
RUN go build -ldflags="-s -w" -o app ./main.go



FROM alpine

WORKDIR /app
COPY --from=builder /build/app /app/

CMD ["./app"]
