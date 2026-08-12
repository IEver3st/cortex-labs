import React, { useState, useRef, useCallback } from "react";
import { motion } from "motion/react";
import { ChevronRight, Upload, X, Plus, Copy, RotateCcw } from "lucide-react";
import { Input } from "./ui/input";
function classNames(...classes) {
  return classes.filter(Boolean).join(" ");
}

const safeCn = (...args) => classNames(...args);

export function CyberPanel({ children, collapsed, isBooting, statusBar, footer, tabs, activeTab, onTabChange }) {
  const hasTabs = Boolean(tabs && tabs.length > 0);
  return (
    <motion.aside
      className={safeCn("cyber-panel", hasTabs && "cyber-panel--tabbed")}
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
      {hasTabs && (
        <nav className="cyber-tab-rail" role="tablist" aria-label="Control panel views">
          {tabs.map((tab) => {
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.id}
                id={`cyber-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`cyber-tab-panel-${tab.id}`}
                className={safeCn("cyber-tab-btn", activeTab === tab.id && "cyber-tab-btn--active")}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => onTabChange?.(tab.id)}
                onKeyDown={(event) => {
                  const currentIndex = tabs.findIndex((item) => item.id === tab.id);
                  let nextIndex = currentIndex;
                  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
                  else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                  else if (event.key === "Home") nextIndex = 0;
                  else if (event.key === "End") nextIndex = tabs.length - 1;
                  else return;
                  event.preventDefault();
                  onTabChange?.(tabs[nextIndex].id);
                  event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')?.[nextIndex]?.focus();
                }}
                title={tab.label}
              >
                {TabIcon && <TabIcon className="cyber-tab-icon" />}
                <span className="cyber-tab-label">{tab.label}</span>
              </button>
            );
          })}
        </nav>
      )}
      <div className="cyber-panel-scroll">
        {children}
      </div>
      {footer}
      {statusBar}
    </motion.aside>
  );
}

export function CyberTabPanel({ id, active, children }) {
  return (
    <div
      id={`cyber-tab-panel-${id}`}
      role="tabpanel"
      className={safeCn("cyber-tab-panel", active && "cyber-tab-panel--active")}
      aria-hidden={!active}
      aria-labelledby={`cyber-tab-${id}`}
      hidden={!active}
    >
      {children}
    </div>
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
        inert={!open}
      >
        <div className="cyber-section-content">
          {children}
        </div>
      </div>
    </div>
  );
}

export function CyberButton({ children, onClick, variant = "blue", className, disabled, ...props }) {
  const baseStyles = "relative group w-full h-9 flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden";
  
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

export function ColorRow({ label, value, onChange, onReset, onCopy, swatches, pickerLabel, resetTitle }) {
  return (
    <div className="cs-color-row">
      <div className="cs-color-row-header">
        <span className="cs-color-row-label">{label}</span>
        <div className="cs-color-row-controls">
          <div className="color-swatch-wrapper cs-color-row-swatch">
            <div className="color-swatch" style={{ background: value }} />
            <input
              type="color"
              value={value}
              onChange={(event) => onChange(event.currentTarget.value)}
              className="color-picker-native"
              aria-label={pickerLabel}
            />
          </div>
          <Input
            className="flex-1 h-7 bg-[var(--mg-input-bg)] border-[var(--mg-border)] text-[var(--mg-fg)] text-[10px]"
            style={{ fontFamily: "var(--font-hud)", borderRadius: "var(--mg-radius)" }}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            aria-label={`${label} hex value`}
          />
          <button type="button" className="cs-copy-btn" onClick={() => onCopy(value)} title="Copy hex"><Copy className="h-3 w-3" /></button>
          <button
            type="button"
            className="cs-color-row-reset"
            onClick={onReset}
            title={resetTitle}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
      </div>
      {swatches && swatches.length > 0 && (
        <div className="cs-swatches cs-swatches--compact">
          {swatches.map((color) => (
            <button key={color} className="cs-swatch-dot cs-swatch-dot--sm" style={{ background: color }} onClick={() => onChange(color)} title={color} />
          ))}
        </div>
      )}
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
          aria-label={label}
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
