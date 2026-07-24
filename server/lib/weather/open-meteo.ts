/**
 * Open-Meteo Weather Service
 *
 * - Archive API:历史天气(活动同步回填用)
 * - Forecast API:实况 + 逐小时/逐日预报(PR 对话环境感知用)
 * - Air Quality API:AQI/PM2.5(同厂免费,无需 key)
 * No API key required. Rate limit: 10,000 requests/day.
 */

export interface WeatherData {
  temperature: number // °C
  humidity: number // %
  windSpeed: number // km/h
  weatherCode: number // WMO code
  description: string // Human-readable description
}

/**
 * WMO Weather Interpretation Codes → Chinese descriptions
 * Reference: https://open-meteo.com/en/docs#weathervariables
 */
const WMO_DESCRIPTIONS: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴天',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '大冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '小冻雨',
  67: '大冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '大阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷暴',
  96: '雷暴伴小冰雹',
  99: '雷暴伴大冰雹',
}

function getWeatherDescription(code: number): string {
  return WMO_DESCRIPTIONS[code] ?? '未知'
}

interface OpenMeteoHourlyResponse {
  hourly: {
    time: string[]
    temperature_2m: number[]
    relative_humidity_2m: number[]
    wind_speed_10m: number[]
    weather_code: number[]
  }
}

/**
 * Fetch historical weather for a specific activity location and time.
 * Uses Open-Meteo Archive API which provides free historical weather data.
 *
 * @returns WeatherData or null if the request fails or data is unavailable
 */
export async function fetchWeatherForActivity(
  lat: number,
  lng: number,
  startTime: Date,
): Promise<WeatherData | null> {
  try {
    // Format date as YYYY-MM-DD for the API
    const dateStr = startTime.toISOString().split('T')[0]
    const hour = startTime.getUTCHours()

    const url = new URL('https://archive-api.open-meteo.com/v1/archive')
    url.searchParams.set('latitude', lat.toFixed(4))
    url.searchParams.set('longitude', lng.toFixed(4))
    url.searchParams.set('start_date', dateStr)
    url.searchParams.set('end_date', dateStr)
    url.searchParams.set(
      'hourly',
      'temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code',
    )

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      console.warn(`Open-Meteo API returned ${response.status} for ${dateStr}`)
      return null
    }

    const data = (await response.json()) as OpenMeteoHourlyResponse

    if (!data.hourly || data.hourly.time.length === 0) {
      return null
    }

    // Reason: Open-Meteo returns UTC hourly data; pick the hour matching the activity start
    const hourIndex = Math.min(hour, data.hourly.time.length - 1)

    const temperature = data.hourly.temperature_2m[hourIndex]
    const humidity = data.hourly.relative_humidity_2m[hourIndex]
    const windSpeed = data.hourly.wind_speed_10m[hourIndex]
    const weatherCode = data.hourly.weather_code[hourIndex]

    // Validate that we got real data (not null/undefined from sparse responses)
    if (temperature == null || humidity == null || windSpeed == null || weatherCode == null) {
      return null
    }

    return {
      temperature: Math.round(temperature * 10) / 10,
      humidity: Math.round(humidity),
      windSpeed: Math.round(windSpeed * 10) / 10,
      weatherCode,
      description: getWeatherDescription(weatherCode),
    }
  } catch (error) {
    console.warn('Failed to fetch weather data:', error)
    return null
  }
}

// ─── Forecast(实况 + 预报,PR 环境感知) ──────────────────────────────────────

export interface ForecastCurrent {
  timeLocal: string // 'YYYY-MM-DDTHH:mm'(请求时区本地时间)
  temperature: number // °C
  apparentTemperature: number // 体感 °C
  humidity: number // %
  windSpeed: number // km/h
  precipitation: number // 过去 1h 降水 mm
  weatherCode: number
  description: string
}

export interface ForecastHour {
  timeLocal: string // 'YYYY-MM-DDTHH:mm'
  temperature: number
  precipitationProbability: number | null // %
  weatherCode: number
  description: string
}

export interface ForecastDay {
  date: string // 'YYYY-MM-DD'
  tempMin: number
  tempMax: number
  precipitationProbabilityMax: number | null
  weatherCode: number
  description: string
  sunrise: string // 'HH:mm'
  sunset: string // 'HH:mm'
}

export interface ForecastData {
  current: ForecastCurrent
  hourly: ForecastHour[]
  daily: ForecastDay[]
}

interface OpenMeteoForecastResponse {
  current?: {
    time: string
    temperature_2m: number
    apparent_temperature: number
    relative_humidity_2m: number
    precipitation: number
    weather_code: number
    wind_speed_10m: number
  }
  hourly?: {
    time: string[]
    temperature_2m: Array<number | null>
    precipitation_probability: Array<number | null>
    weather_code: Array<number | null>
  }
  daily?: {
    time: string[]
    weather_code: Array<number | null>
    temperature_2m_max: Array<number | null>
    temperature_2m_min: Array<number | null>
    precipitation_probability_max: Array<number | null>
    sunrise: string[]
    sunset: string[]
  }
}

/** 'YYYY-MM-DDTHH:mm' → 'HH:mm'(Open-Meteo 带 timezone 参数时返回的就是本地时间)。 */
function localClock(isoLocal: string): string {
  return isoLocal.split('T')[1]?.slice(0, 5) ?? isoLocal
}

export interface GeocodeResult {
  lat: number
  lng: number
  /** 呈现用地名,如「上海」「杭州·浙江省」。 */
  label: string
}

/**
 * 城市/地名 → 经纬度(Open-Meteo 同厂免费 geocoding,支持中文,无需 key)。
 * 供 query_weather 的 place 参数用:PR 不再只会查常跑地点。
 */
export async function geocodeCity(name: string): Promise<GeocodeResult | null> {
  try {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
    url.searchParams.set('name', name)
    url.searchParams.set('count', '1')
    url.searchParams.set('language', 'zh')
    url.searchParams.set('format', 'json')

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      console.warn(`Open-Meteo geocoding API returned ${response.status}`)
      return null
    }
    const data = (await response.json()) as {
      results?: Array<{ name?: string; latitude?: number; longitude?: number; admin1?: string }>
    }
    const first = data.results?.[0]
    if (!first || first.latitude == null || first.longitude == null) return null
    const label = first.admin1 && first.admin1 !== first.name ? `${first.name}·${first.admin1}` : (first.name ?? name)
    return { lat: first.latitude, lng: first.longitude, label }
  } catch (error) {
    console.warn('Open-Meteo geocoding 失败:', (error as Error).message)
    return null
  }
}

/**
 * 实况 + 未来最多 7 天预报(逐小时 + 逐日,含日出日落)。
 * timezone 固定 Asia/Shanghai:返回的所有时间串都是上海本地时间,渲染无需再换算。
 *
 * pastDays > 0 时连带返回近 N 天的当天实况(Open-Meteo forecast API 原生 past_days,
 * 官方上限 92;与预报同构,近期日期给的是实测/再分析值)——「复盘过去某天」用。
 * Reason: 不走 archive-api——ERA5 归档有约 5 天延迟,连「昨天」都罩不住;
 * forecast+past_days 无延迟且复用现有解析,默认 0 时行为与旧版完全一致。
 */
export async function fetchForecast(lat: number, lng: number, days = 7, pastDays = 0): Promise<ForecastData | null> {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast')
    url.searchParams.set('latitude', lat.toFixed(4))
    url.searchParams.set('longitude', lng.toFixed(4))
    url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m')
    url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code')
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset')
    url.searchParams.set('timezone', 'Asia/Shanghai')
    url.searchParams.set('forecast_days', String(Math.min(Math.max(days, 1), 7)))
    const past = Math.min(Math.max(Math.trunc(pastDays), 0), 92)
    if (past > 0) url.searchParams.set('past_days', String(past))

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      console.warn(`Open-Meteo forecast API returned ${response.status}`)
      return null
    }
    const data = (await response.json()) as OpenMeteoForecastResponse
    const cur = data.current
    if (!cur || cur.temperature_2m == null || cur.weather_code == null) return null

    const hourly: ForecastHour[] = (data.hourly?.time ?? [])
      .map((time, index) => {
        const temperature = data.hourly?.temperature_2m[index]
        const weatherCode = data.hourly?.weather_code[index]
        if (temperature == null || weatherCode == null) return null
        return {
          timeLocal: time,
          temperature: Math.round(temperature * 10) / 10,
          precipitationProbability: data.hourly?.precipitation_probability[index] ?? null,
          weatherCode,
          description: getWeatherDescription(weatherCode),
        }
      })
      .filter((hour): hour is ForecastHour => hour !== null)

    const daily: ForecastDay[] = (data.daily?.time ?? [])
      .map((date, index) => {
        const tempMin = data.daily?.temperature_2m_min[index]
        const tempMax = data.daily?.temperature_2m_max[index]
        const weatherCode = data.daily?.weather_code[index]
        const sunrise = data.daily?.sunrise[index]
        const sunset = data.daily?.sunset[index]
        if (tempMin == null || tempMax == null || weatherCode == null || !sunrise || !sunset) return null
        return {
          date,
          tempMin: Math.round(tempMin),
          tempMax: Math.round(tempMax),
          precipitationProbabilityMax: data.daily?.precipitation_probability_max[index] ?? null,
          weatherCode,
          description: getWeatherDescription(weatherCode),
          sunrise: localClock(sunrise),
          sunset: localClock(sunset),
        }
      })
      .filter((day): day is ForecastDay => day !== null)

    return {
      current: {
        timeLocal: cur.time,
        temperature: Math.round(cur.temperature_2m * 10) / 10,
        apparentTemperature: Math.round(cur.apparent_temperature * 10) / 10,
        humidity: Math.round(cur.relative_humidity_2m),
        windSpeed: Math.round(cur.wind_speed_10m * 10) / 10,
        precipitation: cur.precipitation ?? 0,
        weatherCode: cur.weather_code,
        description: getWeatherDescription(cur.weather_code),
      },
      hourly,
      daily,
    }
  } catch (error) {
    console.warn('Failed to fetch forecast:', error)
    return null
  }
}

// ─── Air Quality(AQI/PM2.5) ────────────────────────────────────────────────

export interface AirQualityData {
  aqi: number // US AQI
  pm25: number | null // μg/m³
  label: string // 优/良/轻度污染/…
}

/** US AQI 分级 → 中文标签(与国内叫法对齐,只做粗分级)。 */
export function aqiLabel(aqi: number): string {
  if (aqi <= 50) return '优'
  if (aqi <= 100) return '良'
  if (aqi <= 150) return '轻度污染'
  if (aqi <= 200) return '中度污染'
  if (aqi <= 300) return '重度污染'
  return '严重污染'
}

interface OpenMeteoAirQualityResponse {
  current?: { us_aqi: number | null; pm2_5: number | null }
}

export async function fetchCurrentAirQuality(lat: number, lng: number): Promise<AirQualityData | null> {
  try {
    const url = new URL('https://air-quality-api.open-meteo.com/v1/air-quality')
    url.searchParams.set('latitude', lat.toFixed(4))
    url.searchParams.set('longitude', lng.toFixed(4))
    url.searchParams.set('current', 'us_aqi,pm2_5')
    url.searchParams.set('timezone', 'Asia/Shanghai')

    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      console.warn(`Open-Meteo air-quality API returned ${response.status}`)
      return null
    }
    const data = (await response.json()) as OpenMeteoAirQualityResponse
    const aqi = data.current?.us_aqi
    if (aqi == null) return null
    return {
      aqi: Math.round(aqi),
      pm25: data.current?.pm2_5 == null ? null : Math.round(data.current.pm2_5),
      label: aqiLabel(Math.round(aqi)),
    }
  } catch (error) {
    console.warn('Failed to fetch air quality:', error)
    return null
  }
}
