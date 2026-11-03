import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// GPS 좌표 배열을 지도 위 경로선으로 그린다. 좌표를 다시 측정하지 않고 받은 points만 쓴다.
// 저장 API 좌표 이름은 latitude/longitude, Leaflet은 [위도, 경도] 순서다.

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const DEFAULT_CENTER = [37.5665, 126.978]; // 좌표가 없을 때 서울 시청

const toLatLng = (p) => [p.latitude, p.longitude];

/**
 * @param points  [{latitude, longitude, timestamp}]
 * @param live    true면 마지막 좌표를 따라간다 (러닝 중). 사용자가 지도를 움직이면 따라가기를 멈춘다.
 * @param emptyText 좌표가 없을 때 안내 문구
 */
export default function RouteMap({ points = [], live = false, emptyText = "경로가 없어요", className = "" }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef(null);
  const followRef = useRef(live);
  const [following, setFollowing] = useState(live);

  // 지도 생성 (한 번)
  useEffect(() => {
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: true,
      center: DEFAULT_CENTER,
      zoom: 15,
    });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    map.attributionControl.setPrefix(false);

    const casing = L.polyline([], { color: "#ffffff", weight: 9, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(map);
    const line = L.polyline([], { color: "#3f6124", weight: 5, lineCap: "round", lineJoin: "round" }).addTo(map);
    const start = L.circleMarker(DEFAULT_CENTER, { radius: 7, color: "#ffffff", weight: 3, fillColor: "#3f6124", fillOpacity: 1 });
    const end = L.circleMarker(DEFAULT_CENTER, { radius: 8, color: "#20271d", weight: 3, fillColor: "#c5f16b", fillOpacity: 1 });
    layersRef.current = { casing, line, start, end };

    // dragstart는 손으로 끌 때만 발생한다(setView로는 발생하지 않음). 이때 따라가기를 끈다.
    map.on("dragstart", () => {
      followRef.current = false;
      setFollowing(false);
    });

    mapRef.current = map;
    // 컨테이너 크기가 레이아웃 후 정해지는 경우 대비
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(containerRef.current);
    return () => {
      resize.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // 좌표가 바뀔 때마다 경로 갱신
  useEffect(() => {
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!map || !layers) return;
    const latLngs = points.map(toLatLng);
    layers.casing.setLatLngs(latLngs);
    layers.line.setLatLngs(latLngs);

    if (latLngs.length === 0) {
      layers.start.remove();
      layers.end.remove();
      return;
    }
    layers.start.setLatLng(latLngs[0]).addTo(map);
    layers.end.setLatLng(latLngs[latLngs.length - 1]).addTo(map);
    layers.end.bringToFront();

    if (live) {
      if (followRef.current) map.setView(latLngs[latLngs.length - 1], Math.max(map.getZoom(), 17), { animate: true });
    } else {
      fitAll(map, latLngs);
    }
  }, [points, live]);

  const showAll = () => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;
    fitAll(map, points.map(toLatLng));
    if (live) {
      followRef.current = false;
      setFollowing(false);
    }
  };

  const followMe = () => {
    followRef.current = true;
    setFollowing(true);
    const map = mapRef.current;
    if (map && points.length) map.setView(toLatLng(points[points.length - 1]), 17);
  };

  return (
    <div className={`route-map ${className}`}>
      <div ref={containerRef} className="route-map__canvas" />
      {points.length === 0 && <div className="route-map__empty">{emptyText}</div>}
      {points.length > 0 && (
        <div className="route-map__controls">
          <button type="button" className="map-chip" onClick={showAll}>
            전체 경로
          </button>
          {live && !following && (
            <button type="button" className="map-chip map-chip--dark" onClick={followMe}>
              내 위치
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function fitAll(map, latLngs) {
  if (latLngs.length === 1) {
    map.setView(latLngs[0], 17, { animate: false });
    return;
  }
  map.fitBounds(L.latLngBounds(latLngs), { padding: [28, 28], maxZoom: 18, animate: false });
}
