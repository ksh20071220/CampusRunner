FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake libssl-dev python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cmake -S . -B /build -DCMAKE_BUILD_TYPE=Release && cmake --build /build -j2 && ctest --test-dir /build --output-on-failure

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --create-home runner && mkdir /data && chown runner:runner /data
COPY --from=build /build/campus_server /usr/local/bin/campus_server
USER runner
WORKDIR /data
EXPOSE 8080
VOLUME ["/data"]
ENTRYPOINT ["campus_server"]
CMD ["/data/campus.sqlite3", "0.0.0.0:8080"]
