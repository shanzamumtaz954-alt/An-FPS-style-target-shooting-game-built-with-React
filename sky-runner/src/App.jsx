import { useState, useEffect, useRef, useCallback } from 'react'
import './App.css'

/* ------------------------------------------------------------------
   GAME CONFIGURATION
   Each entry describes the difficulty for that level.
   Difficulty increases every level: more targets, faster movement,
   smaller/shorter-lived targets.
------------------------------------------------------------------- */
const LEVELS = [
  { targetCount: 3, speed: 2.2, lifespan: 3500, targetSize: 70, timeLimit: 30 },
  { targetCount: 4, speed: 2.8, lifespan: 3200, targetSize: 65, timeLimit: 30 },
  { targetCount: 5, speed: 3.4, lifespan: 2900, targetSize: 60, timeLimit: 30 },
  { targetCount: 6, speed: 4.0, lifespan: 2600, targetSize: 55, timeLimit: 30 },
  { targetCount: 7, speed: 4.6, lifespan: 2300, targetSize: 50, timeLimit: 30 },
]

const MAX_AMMO = 15
const RELOAD_TIME = 1400 // ms
const MISS_HEALTH_PENALTY = 8
const EXPIRE_HEALTH_PENALTY = 6
const BASE_SCORE = 15
const TICK_MS = 40 // ~25 updates per second for target movement
const MAX_HEALTH = 100
const HIGH_SCORE_KEY = 'cyberStrikeHighScore'

let idCounter = 0
const nextId = () => ++idCounter

/* ------------------------------------------------------------------
   SOUND ENGINE
   Small synthesized sound effects using the native Web Audio API —
   no audio files or extra libraries needed.
------------------------------------------------------------------- */
let sharedAudioCtx = null

function getAudioCtx() {
  if (typeof window === 'undefined') return null
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  if (!sharedAudioCtx) sharedAudioCtx = new Ctx()
  if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume()
  return sharedAudioCtx
}

function playTone({ type = 'square', startFreq, endFreq, duration, volume = 0.2 }) {
  const ctx = getAudioCtx()
  if (!ctx) return
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(startFreq, now)
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration)
  gain.gain.setValueAtTime(volume, now)
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)
  osc.stop(now + duration)
}

function playGunshotSound() {
  playTone({ type: 'square', startFreq: 190, endFreq: 40, duration: 0.14, volume: 0.22 })
}
function playHitSound() {
  playTone({ type: 'sine', startFreq: 900, endFreq: 1500, duration: 0.09, volume: 0.18 })
}
function playReloadSound() {
  playTone({ type: 'square', startFreq: 320, endFreq: 220, duration: 0.06, volume: 0.15 })
  setTimeout(() => playTone({ type: 'square', startFreq: 260, endFreq: 380, duration: 0.06, volume: 0.15 }), 220)
}
function playDamageSound() {
  playTone({ type: 'sawtooth', startFreq: 140, endFreq: 60, duration: 0.18, volume: 0.2 })
}
function playEmptySound() {
  playTone({ type: 'square', startFreq: 500, endFreq: 500, duration: 0.04, volume: 0.1 })
}

/* ------------------------------------------------------------------
   HELPERS
------------------------------------------------------------------- */
function createTarget(levelConfig, bounds) {
  const size = levelConfig.targetSize
  const maxX = Math.max(bounds.width - size, 10)
  const maxY = Math.max(bounds.height - size, 10)
  const angle = Math.random() * Math.PI * 2
  return {
    id: nextId(),
    x: Math.random() * maxX,
    y: Math.random() * maxY,
    dx: Math.cos(angle) * levelConfig.speed,
    dy: Math.sin(angle) * levelConfig.speed,
    size,
    timeLeft: levelConfig.lifespan,
    maxLife: levelConfig.lifespan,
  }
}

function loadHighScore() {
  const saved = Number(localStorage.getItem(HIGH_SCORE_KEY))
  return Number.isFinite(saved) ? saved : 0
}

/* ------------------------------------------------------------------
   MAIN APP COMPONENT
------------------------------------------------------------------- */
export default function App() {
  // gameState: 'start' | 'playing' | 'gameover'
  const [gameState, setGameState] = useState('start')
  const [isPaused, setIsPaused] = useState(false)

  const [level, setLevel] = useState(1)
  const [score, setScore] = useState(0)
  const [combo, setCombo] = useState(0)
  const [health, setHealth] = useState(MAX_HEALTH)
  const [ammo, setAmmo] = useState(MAX_AMMO)
  const [isReloading, setIsReloading] = useState(false)
  const [timeLeft, setTimeLeft] = useState(LEVELS[0].timeLimit)

  const [shotsFired, setShotsFired] = useState(0)
  const [hitsCount, setHitsCount] = useState(0)

  const [targets, setTargets] = useState([])
  const [highScore, setHighScore] = useState(loadHighScore)
  const [isNewHighScore, setIsNewHighScore] = useState(false)
  const [gameOverReason, setGameOverReason] = useState('health') // 'health' | 'victory'

  // Realism layer: crosshair, weapon recoil/flash, screen shake, hit/miss effects
  const [effects, setEffects] = useState([]) // { id, type: 'hit' | 'hole', x, y }
  const [crosshairPos, setCrosshairPos] = useState({ x: null, y: null })
  const [isRecoiling, setIsRecoiling] = useState(false)
  const [isShaking, setIsShaking] = useState(false)
  const [muzzleFlash, setMuzzleFlash] = useState(false)

  const arenaRef = useRef(null)
  const boundsRef = useRef({ width: 800, height: 500 })
  const targetsRef = useRef([])
  const reloadTimeoutRef = useRef(null)
  const recoilTimeoutRef = useRef(null)
  const flashTimeoutRef = useRef(null)
  const shakeTimeoutRef = useRef(null)

  const accuracy = shotsFired > 0 ? Math.round((hitsCount / shotsFired) * 100) : 100

  const spawnEffect = useCallback((type, x, y) => {
    const id = nextId()
    setEffects((prev) => [...prev, { id, type, x, y }])
    window.setTimeout(() => {
      setEffects((prev) => prev.filter((ef) => ef.id !== id))
    }, type === 'hole' ? 900 : 450)
  }, [])

  const triggerRecoil = useCallback(() => {
    setIsRecoiling(true)
    setMuzzleFlash(true)
    window.clearTimeout(recoilTimeoutRef.current)
    window.clearTimeout(flashTimeoutRef.current)
    recoilTimeoutRef.current = window.setTimeout(() => setIsRecoiling(false), 110)
    flashTimeoutRef.current = window.setTimeout(() => setMuzzleFlash(false), 70)
  }, [])

  const triggerShake = useCallback(() => {
    setIsShaking(true)
    window.clearTimeout(shakeTimeoutRef.current)
    shakeTimeoutRef.current = window.setTimeout(() => setIsShaking(false), 260)
  }, [])

  /* ---------------- Arena bounds tracking (responsive) ---------------- */
  useEffect(() => {
    if (!arenaRef.current) return
    const updateBounds = () => {
      const rect = arenaRef.current.getBoundingClientRect()
      boundsRef.current = { width: rect.width, height: rect.height }
    }
    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(arenaRef.current)
    window.addEventListener('resize', updateBounds)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
    }
  }, [])

  /* ---------------- Start / Restart ---------------- */
  const startGame = useCallback(() => {
    const cfg = LEVELS[0]
    const bounds = boundsRef.current
    const initialTargets = Array.from({ length: cfg.targetCount }, () => createTarget(cfg, bounds))
    targetsRef.current = initialTargets

    setLevel(1)
    setScore(0)
    setCombo(0)
    setHealth(MAX_HEALTH)
    setAmmo(MAX_AMMO)
    setIsReloading(false)
    setTimeLeft(cfg.timeLimit)
    setShotsFired(0)
    setHitsCount(0)
    setTargets(initialTargets)
    setIsNewHighScore(false)
    setIsPaused(false)
    setGameState('playing')
  }, [])

  /* ---------------- End game ---------------- */
  const endGame = useCallback(
    (reason) => {
      setGameOverReason(reason)
      setGameState('gameover')
      setTargets([])
      targetsRef.current = []
      setScore((currentScore) => {
        const savedHigh = loadHighScore()
        if (currentScore > savedHigh) {
          localStorage.setItem(HIGH_SCORE_KEY, String(currentScore))
          setHighScore(currentScore)
          setIsNewHighScore(true)
        }
        return currentScore
      })
    },
    []
  )

  /* ---------------- Level progression ---------------- */
  const advanceLevel = useCallback(() => {
    if (level >= LEVELS.length) {
      endGame('victory')
      return
    }
    const nextLevelNumber = level + 1
    const cfg = LEVELS[nextLevelNumber - 1]
    const bounds = boundsRef.current
    const freshTargets = Array.from({ length: cfg.targetCount }, () => createTarget(cfg, bounds))
    targetsRef.current = freshTargets

    setLevel(nextLevelNumber)
    setTargets(freshTargets)
    setTimeLeft(cfg.timeLimit)
    setAmmo(MAX_AMMO)
    setIsReloading(false)
    if (reloadTimeoutRef.current) {
      clearTimeout(reloadTimeoutRef.current)
      reloadTimeoutRef.current = null
    }
  }, [level, endGame])

  /* ---------------- Movement / lifespan loop ---------------- */
  useEffect(() => {
    if (gameState !== 'playing' || isPaused) return

    const cfg = LEVELS[level - 1]

    const tick = () => {
      const bounds = boundsRef.current
      let expiredCount = 0

      const updated = targetsRef.current.map((t) => {
        let nx = t.x + t.dx
        let ny = t.y + t.dy
        let ndx = t.dx
        let ndy = t.dy

        const maxX = bounds.width - t.size
        const maxY = bounds.height - t.size

        if (nx <= 0 || nx >= maxX) {
          ndx = -ndx
          nx = Math.max(0, Math.min(nx, maxX))
        }
        if (ny <= 0 || ny >= maxY) {
          ndy = -ndy
          ny = Math.max(0, Math.min(ny, maxY))
        }

        return { ...t, x: nx, y: ny, dx: ndx, dy: ndy, timeLeft: t.timeLeft - TICK_MS }
      })

      const alive = []
      updated.forEach((t) => {
        if (t.timeLeft <= 0) {
          expiredCount += 1
        } else {
          alive.push(t)
        }
      })

      while (alive.length < cfg.targetCount) {
        alive.push(createTarget(cfg, bounds))
      }

      targetsRef.current = alive
      setTargets(alive)

      if (expiredCount > 0) {
        setCombo(0)
        setHealth((h) => Math.max(0, h - expiredCount * EXPIRE_HEALTH_PENALTY))
        triggerShake()
        playDamageSound()
      }
    }

    const intervalId = setInterval(tick, TICK_MS)
    return () => clearInterval(intervalId)
  }, [gameState, isPaused, level, triggerShake])

  /* ---------------- Countdown timer ---------------- */
  useEffect(() => {
    if (gameState !== 'playing' || isPaused) return

    const intervalId = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(intervalId)
          advanceLevel()
          return 0
        }
        return t - 1
      })
    }, 1000)

    return () => clearInterval(intervalId)
  }, [gameState, isPaused, level, advanceLevel])

  /* ---------------- Health watcher ---------------- */
  useEffect(() => {
    if (gameState === 'playing' && health <= 0) {
      endGame('health')
    }
  }, [health, gameState, endGame])

  /* ---------------- Shooting logic ---------------- */
  const registerHit = useCallback((id) => {
    targetsRef.current = targetsRef.current.filter((t) => t.id !== id)
    setTargets(targetsRef.current)
    setHitsCount((h) => h + 1)
    setCombo((prevCombo) => {
      const newCombo = prevCombo + 1
      const comboBonus = Math.min(newCombo, 20) * 2
      setScore((s) => s + BASE_SCORE + comboBonus)
      return newCombo
    })
  }, [])

  const registerMiss = useCallback(() => {
    setCombo(0)
    setHealth((h) => Math.max(0, h - MISS_HEALTH_PENALTY))
    triggerShake()
    playDamageSound()
  }, [triggerShake])

  const canShoot = gameState === 'playing' && !isPaused && !isReloading && ammo > 0

  const getRelativeCoords = useCallback((e) => {
    const rect = arenaRef.current ? arenaRef.current.getBoundingClientRect() : null
    if (!rect) return { x: 0, y: 0 }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  const handleTargetClick = useCallback(
    (e, id) => {
      e.stopPropagation()
      if (!canShoot) {
        if (gameState === 'playing' && !isPaused && ammo === 0 && !isReloading) playEmptySound()
        return
      }
      setAmmo((a) => a - 1)
      setShotsFired((s) => s + 1)
      const { x, y } = getRelativeCoords(e)
      registerHit(id)
      triggerRecoil()
      playGunshotSound()
      playHitSound()
      spawnEffect('hit', x, y)
    },
    [canShoot, registerHit, triggerRecoil, spawnEffect, getRelativeCoords, gameState, isPaused, ammo, isReloading]
  )

  const handleArenaMiss = useCallback(
    (e) => {
      if (!canShoot) {
        if (gameState === 'playing' && !isPaused && ammo === 0 && !isReloading) playEmptySound()
        return
      }
      setAmmo((a) => a - 1)
      setShotsFired((s) => s + 1)
      const { x, y } = getRelativeCoords(e)
      registerMiss()
      triggerRecoil()
      playGunshotSound()
      spawnEffect('hole', x, y)
    },
    [canShoot, registerMiss, triggerRecoil, spawnEffect, getRelativeCoords, gameState, isPaused, ammo, isReloading]
  )

  const handleArenaMouseMove = useCallback((e) => {
    const { x, y } = getRelativeCoords(e)
    setCrosshairPos({ x, y })
  }, [getRelativeCoords])

  const handleArenaMouseLeave = useCallback(() => {
    setCrosshairPos({ x: null, y: null })
  }, [])

  const handleReload = useCallback(() => {
    if (isReloading || ammo === MAX_AMMO || gameState !== 'playing' || isPaused) return
    setIsReloading(true)
    playReloadSound()
    reloadTimeoutRef.current = setTimeout(() => {
      setAmmo(MAX_AMMO)
      setIsReloading(false)
      reloadTimeoutRef.current = null
    }, RELOAD_TIME)
  }, [isReloading, ammo, gameState, isPaused])

  useEffect(() => {
    return () => {
      if (reloadTimeoutRef.current) clearTimeout(reloadTimeoutRef.current)
    }
  }, [])

  /* ---------------- Pause / Resume ---------------- */
  const togglePause = useCallback(() => {
    if (gameState !== 'playing') return
    setIsPaused((p) => !p)
  }, [gameState])

  /* ---------------- Keyboard shortcuts ---------------- */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (gameState !== 'playing') return
      if (e.key === 'r' || e.key === 'R') handleReload()
      if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') togglePause()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [gameState, handleReload, togglePause])

  const backToMenu = useCallback(() => {
    setGameState('start')
  }, [])

  /* ---------------- Render ---------------- */
  return (
    <div className="app">
      {gameState === 'start' && <StartScreen onStart={startGame} highScore={highScore} />}

      {gameState === 'playing' && (
        <GameScreen
          arenaRef={arenaRef}
          targets={targets}
          score={score}
          combo={combo}
          health={health}
          ammo={ammo}
          maxAmmo={MAX_AMMO}
          isReloading={isReloading}
          level={level}
          totalLevels={LEVELS.length}
          timeLeft={timeLeft}
          accuracy={accuracy}
          isPaused={isPaused}
          onArenaMiss={handleArenaMiss}
          onTargetClick={handleTargetClick}
          onReload={handleReload}
          onTogglePause={togglePause}
          onRestart={startGame}
          onQuit={backToMenu}
          effects={effects}
          crosshairPos={crosshairPos}
          isRecoiling={isRecoiling}
          isShaking={isShaking}
          muzzleFlash={muzzleFlash}
          onArenaMouseMove={handleArenaMouseMove}
          onArenaMouseLeave={handleArenaMouseLeave}
        />
      )}

      {gameState === 'gameover' && (
        <GameOverScreen
          reason={gameOverReason}
          score={score}
          level={level}
          accuracy={accuracy}
          highScore={highScore}
          isNewHighScore={isNewHighScore}
          onRestart={startGame}
          onMenu={backToMenu}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------
   START SCREEN
------------------------------------------------------------------- */
function StartScreen({ onStart, highScore }) {
  return (
    <div className="screen start-screen">
      <div className="scanlines" />
      <div className="start-content">
        <h1 className="game-title">
          CYBER <span className="accent">STRIKE</span>
        </h1>
        <p className="game-subtitle">Target Shooting Arena</p>

        <div className="high-score-badge">
          High Score: <strong>{highScore}</strong>
        </div>

        <div className="instructions">
          <h2>Mission Briefing</h2>
          <ul>
            <li>🎯 Click moving targets in the arena to score hits</li>
            <li>🔥 Chain hits without missing to build a combo multiplier</li>
            <li>🔫 You have limited ammo — press Reload or hit R to refill</li>
            <li>❤️ Missed shots and escaped targets cost health</li>
            <li>⏱️ Survive the countdown to advance to the next level</li>
            <li>📈 Every level adds more, faster, shorter-lived targets</li>
            <li>⏸️ Press P or Esc anytime to pause</li>
          </ul>
        </div>

        <button className="btn btn-primary btn-glow" onClick={onStart}>
          Start Mission
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------
   GAME SCREEN (HUD + Arena + Pause overlay)
------------------------------------------------------------------- */
function GameScreen({
  arenaRef,
  targets,
  score,
  combo,
  health,
  ammo,
  maxAmmo,
  isReloading,
  level,
  totalLevels,
  timeLeft,
  accuracy,
  isPaused,
  onArenaMiss,
  onTargetClick,
  onReload,
  onTogglePause,
  onRestart,
  onQuit,
  effects,
  crosshairPos,
  isRecoiling,
  isShaking,
  muzzleFlash,
  onArenaMouseMove,
  onArenaMouseLeave,
}) {
  const healthClass = health > 50 ? 'ok' : health > 20 ? 'warn' : 'critical'

  return (
    <div className="screen game-screen">
      <Hud
        score={score}
        combo={combo}
        health={health}
        healthClass={healthClass}
        ammo={ammo}
        maxAmmo={maxAmmo}
        isReloading={isReloading}
        level={level}
        totalLevels={totalLevels}
        timeLeft={timeLeft}
        accuracy={accuracy}
        onTogglePause={onTogglePause}
      />

      <div className="arena-wrapper">
        <div
          className={`arena ${isShaking ? 'shake' : ''}`}
          ref={arenaRef}
          onClick={onArenaMiss}
          onMouseMove={onArenaMouseMove}
          onMouseLeave={onArenaMouseLeave}
        >
          {targets.map((t) => (
            <Target key={t.id} target={t} onClick={onTargetClick} />
          ))}

          {effects.map((ef) =>
            ef.type === 'hit' ? (
              <span key={ef.id} className="fx fx-hit" style={{ left: `${ef.x}px`, top: `${ef.y}px` }}>
                <span className="hit-marker" />
                <span className="spark spark-1" />
                <span className="spark spark-2" />
                <span className="spark spark-3" />
                <span className="spark spark-4" />
              </span>
            ) : (
              <span key={ef.id} className="fx fx-hole" style={{ left: `${ef.x}px`, top: `${ef.y}px` }} />
            )
          )}

          <div className={`gun-viewmodel ${isRecoiling ? 'recoil' : ''} ${isReloading ? 'reloading' : ''}`}>
            <div className={`muzzle-flash ${muzzleFlash ? 'flash' : ''}`} />
            <div className="gun-body" />
          </div>

          {crosshairPos.x !== null && (
            <div
              className={`crosshair ${isRecoiling ? 'recoil' : ''}`}
              style={{ left: `${crosshairPos.x}px`, top: `${crosshairPos.y}px` }}
            />
          )}

          {ammo === 0 && !isReloading && (
            <div className="reload-prompt">OUT OF AMMO — PRESS R OR RELOAD</div>
          )}
        </div>

        <button
          className={`btn btn-reload ${isReloading ? 'reloading' : ''}`}
          onClick={onReload}
          disabled={isReloading || ammo === maxAmmo}
        >
          {isReloading ? 'Reloading…' : `Reload (${ammo}/${maxAmmo})`}
        </button>
      </div>

      {isPaused && (
        <PauseOverlay onResume={onTogglePause} onRestart={onRestart} onQuit={onQuit} />
      )}
    </div>
  )
}

function Hud({
  score,
  combo,
  health,
  healthClass,
  ammo,
  maxAmmo,
  isReloading,
  level,
  totalLevels,
  timeLeft,
  accuracy,
  onTogglePause,
}) {
  return (
    <div className="hud">
      <div className="hud-item">
        <span className="hud-label">Score</span>
        <span className="hud-value">{score}</span>
      </div>

      <div className="hud-item hud-health">
        <span className="hud-label">Health</span>
        <div className="health-bar">
          <div className={`health-fill ${healthClass}`} style={{ width: `${health}%` }} />
        </div>
      </div>

      <div className="hud-item">
        <span className="hud-label">Ammo</span>
        <span className={`hud-value ${isReloading ? 'blink' : ''}`}>
          {ammo}/{maxAmmo}
        </span>
      </div>

      <div className="hud-item">
        <span className="hud-label">Level</span>
        <span className="hud-value">
          {level}/{totalLevels}
        </span>
      </div>

      <div className="hud-item">
        <span className="hud-label">Time</span>
        <span className="hud-value">{timeLeft}s</span>
      </div>

      <div className="hud-item">
        <span className="hud-label">Combo</span>
        <span className="hud-value combo-value">x{combo}</span>
      </div>

      <div className="hud-item">
        <span className="hud-label">Accuracy</span>
        <span className="hud-value">{accuracy}%</span>
      </div>

      <button className="btn btn-pause" onClick={onTogglePause}>
        ⏸ Pause
      </button>
    </div>
  )
}

function Target({ target, onClick }) {
  const lifeRatio = target.timeLeft / target.maxLife
  return (
    <button
      className="target"
      style={{
        left: `${target.x}px`,
        top: `${target.y}px`,
        width: `${target.size}px`,
        height: `${target.size}px`,
        opacity: 0.55 + lifeRatio * 0.45,
      }}
      onClick={(e) => onClick(e, target.id)}
      aria-label="target"
    >
      <span className="target-post" />
      <span className="target-face" />
    </button>
  )
}

function PauseOverlay({ onResume, onRestart, onQuit }) {
  return (
    <div className="overlay">
      <div className="overlay-panel">
        <h2>PAUSED</h2>
        <button className="btn btn-primary" onClick={onResume}>
          Resume
        </button>
        <button className="btn btn-secondary" onClick={onRestart}>
          Restart
        </button>
        <button className="btn btn-secondary" onClick={onQuit}>
          Main Menu
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------
   GAME OVER SCREEN
------------------------------------------------------------------- */
function GameOverScreen({ reason, score, level, accuracy, highScore, isNewHighScore, onRestart, onMenu }) {
  return (
    <div className="screen gameover-screen">
      <div className="overlay-panel gameover-panel">
        <h2 className={reason === 'victory' ? 'victory-title' : 'defeat-title'}>
          {reason === 'victory' ? 'MISSION COMPLETE' : 'GAME OVER'}
        </h2>

        {isNewHighScore && <p className="new-high-score">🏆 NEW HIGH SCORE!</p>}

        <div className="stats-grid">
          <div className="stat">
            <span className="stat-label">Final Score</span>
            <span className="stat-value">{score}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Level Reached</span>
            <span className="stat-value">{level}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Accuracy</span>
            <span className="stat-value">{accuracy}%</span>
          </div>
          <div className="stat">
            <span className="stat-label">High Score</span>
            <span className="stat-value">{highScore}</span>
          </div>
        </div>

        <button className="btn btn-primary btn-glow" onClick={onRestart}>
          Play Again
        </button>
        <button className="btn btn-secondary" onClick={onMenu}>
          Main Menu
        </button>
      </div>
    </div>
  )
}