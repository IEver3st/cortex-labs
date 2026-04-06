import React, { useState, useRef, useCallback } from "react";
import { motion } from "motion/react";
import { ChevronRight, Upload, X, Plus } from "lucide-react";
function classNames(...classes) {
  return classes.filter(Boolean).join(" ");
}

const safeCn = (...args) => classNames(...args);

export function CyberPanel({ children, collapsed, isBooting, statusBar }) {
  return (
    <motion.aside
      className="cyber-panel"
      data-collapsed={collapsed || undefined}
      initial={{ opacity: 0, x: -12 }}
      animate={
        isBooting
          ? { opacity: 0, x: -12 }
          : collapsed
            ? { opacity: 0, x: "-100%" }
            : { opacity: 1, x: 0 }
      }
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="cyber-panel-scroll">
        {children}
      </div>
      {statusBar}
    </motion.aside>
  );
}

export function CyberSection({ title, caption, open, onToggle, contentId, children, icon, color, badge }) {
  const Icon = icon;
  return (
    <div className={safeCn("cyber-section", open && "cyber-section--open")} data-open={open || undefined}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={contentId}
        className="cyber-section-header"
      >
        <div className="cyber-section-left">
          {Icon && <Icon className="cyber-section-icon" />}
          <div className="cyber-section-meta">
            <span className="cyber-section-title">{title}</span>
            {caption && <span className="cyber-section-caption">{caption}</span>}
          </div>
        </div>
        <div className="cyber-section-right">
          {badge && <span className="cyber-section-badge">{badge}</span>}
          <motion.div
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: 0.2 }}
            className="cyber-section-chevron"
          >
            <ChevronRight size={12} />
          </motion.div>
        </div>
      </button>

      {/* CSS Grid accordion — 0fr→1fr requires NO JS height measurement,
          handles dynamic content of any size, never races against renders. */}
      <div
        id={contentId}
        className="cyber-section-body"
        aria-hidden={!open}
      >
        <div className="cyber-section-content">
          {children}
        </div>
      </div>
    </div>
  );
}

export function CyberButton({ children, onClick, variant = "blue", className, disabled, ...props }) {
  const baseStyles = "relative group w-full h-9 flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden";
  
  const variants = {
    blue: "cs-btn--primary",
    purple: "cs-btn--purple",
    orange: "cs-btn--orange",
    secondary: "cs-btn--secondary",
    danger: "cs-btn--danger",
    ghost: "cs-btn--ghost"
  };

  const selectedVariant = variants[variant] || variants.blue;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={safeCn(baseStyles, selectedVariant, className)}
      style={{ fontFamily: "var(--font-hud)" }}
      {...props}
    >
      <span className="relative z-10 flex items-center gap-2">{children}</span>
    </button>
  );
}

export function CyberCard({ children, className }) {
  return (
    <div className={safeCn("cs-card", className)}>
      {children}
    </div>
  );
}

export function CyberLabel({ children, className }) {
    return (
        <label className={safeCn("cs-label", className)} style={{ fontFamily: "var(--font-hud)" }}>
            {children}
        </label>
    );
}

/* ── Material Type Pill Selector ── */
const MATERIAL_TYPES = [
  { id: "paint", label: "Paint", color: "#3dbaa3" },
  { id: "chrome", label: "Chrome", color: "#b8c4d0" },
  { id: "plastic", label: "Plastic", color: "#9fa0a6" },
  { id: "metal", label: "Metal", color: "#ffd700" },
  { id: "glass", label: "Glass", color: "#60a5fa" },
];

export function MaterialTypeSelector({ value, onChange }) {
  return (
    <div className="cs-mat-type-row">
      {MATERIAL_TYPES.map((mat) => (
        <button
          key={mat.id}
          type="button"
          className={safeCn("cs-mat-pill", value === mat.id && "cs-mat-pill--active")}
          style={value === mat.id ? { "--pill-color": mat.color } : undefined}
          onClick={() => onChange(mat.id)}
        >
          <span className="cs-mat-pill-dot" style={{ background: mat.color }} />
          <span>{mat.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ── Material Slider ── */
export function MaterialSlider({ label, value, onChange, min = 0, max = 1, step = 0.01, unit = "", onReset }) {
  const displayVal = unit === "%"
    ? `${Math.round(value * 100)}%`
    : step >= 1
      ? `${Math.round(value)}${unit}`
      : `${value.toFixed(2)}${unit}`;
  return (
    <div className="cs-mat-slider">
      <span className="cs-mat-slider-label">{label}</span>
      <div className="cs-mat-slider-track-wrap">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="cs-mat-slider-input"
        />
        <div className="cs-mat-slider-fill" style={{ width: `${((value - min) / (max - min)) * 100}%` }} />
      </div>
      <span className="cs-mat-slider-readout">{displayVal}</span>
    </div>
  );
}

/* ── Texture Upload Grid ── */
export function TextureUploadGrid({ textures, onAdd, onRemove, maxSlots = 6 }) {
  const fileInputRef = useRef(null);
  
  const handleFileSelect = useCallback(() => {
    if (onAdd) onAdd();
  }, [onAdd]);

  return (
    <div className="cs-tex-grid">
      {textures.map((tex, i) => (
        <div key={tex.id || i} className="cs-tex-slot">
          {tex.thumbnail ? (
            <img src={tex.thumbnail} alt={tex.name || `Texture ${i + 1}`} className="cs-tex-slot-img" />
          ) : (
            <div className="cs-tex-slot-placeholder">
              <span className="cs-tex-slot-ext">{tex.name ? tex.name.split('.').pop().toUpperCase() : '?'}</span>
            </div>
          )}
          <button
            type="button"
            className="cs-tex-slot-remove"
            onClick={() => onRemove(i)}
            title="Remove texture"
          >
            <X size={10} />
          </button>
          <div className="cs-tex-slot-name" title={tex.name}>{tex.name || `Slot ${i + 1}`}</div>
        </div>
      ))}
      {textures.length < maxSlots && (
        <button type="button" className={`cs-tex-slot cs-tex-slot--add ${textures.length === 0 ? "cs-tex-slot--add-full" : ""}`} onClick={handleFileSelect}>
          <Plus size={16} />
          <span>{textures.length === 0 ? "ADD TEXTURE MAP" : "Add"}</span>
        </button>
      )}
    </div>
  );
}

/* ── Toggle Switch ── */
export function CyberToggle({ checked, onChange, size = "sm" }) {
  return (
    <button
      type="button"
      className={safeCn("cs-toggle", checked && "cs-toggle--on", size === "lg" && "cs-toggle--lg")}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <div className="cs-toggle-thumb" />
    </button>
  );
}
