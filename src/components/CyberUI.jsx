import React from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

// Helper for class names if utils doesn't exist
function classNames(...classes) {
  return classes.filter(Boolean).join(" ");
}

const safeCn = (...args) => classNames(...args);

export function CyberPanel({ children, collapsed, isBooting, statusBar }) {
  return (
    <motion.aside
      className="fixed top-[var(--titlebar-height)] left-0 bottom-0 z-10 flex flex-col border-r border-[rgba(255,255,255,0.06)]"
      style={{ width: "var(--panel-width)", background: "rgba(10, 11, 13, 0.98)", fontFamily: "var(--font-hud)", pointerEvents: collapsed ? "none" : "auto", willChange: "transform, opacity" }}
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
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3" style={{ minHeight: 0 }}>
        {children}
      </div>
      {statusBar}
    </motion.aside>
  );
}

export function CyberSection({ title, caption, open, onToggle, contentId, children, icon, color }) {
  return (
    <div className="relative overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={contentId}
        className="w-full flex items-center justify-between py-2 px-1 hover:bg-[rgba(255,255,255,0.02)] transition-colors"
      >
        <div className="flex flex-col items-start min-w-0">
          <span className="text-xs uppercase tracking-[0.18em] text-[rgba(230,235,244,0.92)] font-bold" style={{ fontFamily: "var(--font-hud)" }}>
            {title}
          </span>
          {caption && (
            <span className="text-[9px] truncate w-full text-[rgba(230,235,244,0.4)]" style={{ fontFamily: "var(--font-hud)" }}>
              {caption}
            </span>
          )}
        </div>
        <motion.div
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.2 }}
          className="text-[rgba(230,235,244,0.35)]"
        >
          <ChevronRight size={14} />
        </motion.div>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={contentId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
          >
            <div className="px-1 pb-2 space-y-3">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function CyberButton({ children, onClick, variant = "blue", className, disabled, ...props }) {
  const baseStyles = "relative group w-full h-9 flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden";
  
  const variants = {
    blue: "bg-[#7dd3fc]/10 text-[#7dd3fc] border border-[#7dd3fc]/30 hover:bg-[#7dd3fc]/20 hover:border-[#7dd3fc] hover:shadow-[0_0_15px_-3px_rgba(125,211,252,0.3)]",
    purple: "bg-[#a78bfa]/10 text-[#a78bfa] border border-[#a78bfa]/30 hover:bg-[#a78bfa]/20 hover:border-[#a78bfa] hover:shadow-[0_0_15px_-3px_rgba(167,139,250,0.3)]",
    orange: "bg-[#f97316]/10 text-[#f97316] border border-[#f97316]/30 hover:bg-[#f97316]/20 hover:border-[#f97316] hover:shadow-[0_0_15px_-3px_rgba(249,115,22,0.3)]",
    secondary: "bg-[#1F2833]/50 text-[#C5C6C7] border border-[#C5C6C7]/20 hover:bg-[#1F2833] hover:border-[#C5C6C7]/50",
    danger: "bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 hover:border-red-500",
    ghost: "bg-transparent text-[#C5C6C7]/60 hover:text-[#7dd3fc] hover:bg-[#7dd3fc]/5"
  };

  const selectedVariant = variants[variant] || variants.blue;
  const hoverColor = variant === "purple" ? "#a78bfa" : variant === "orange" ? "#f97316" : "#7dd3fc";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={safeCn(baseStyles, selectedVariant, className)}
      style={{ fontFamily: "var(--font-hud)" }}
      {...props}
    >
      <span className="relative z-10 flex items-center gap-2">{children}</span>
      {/* Glitch hover effect overlay */}
      {!disabled && variant !== "secondary" && variant !== "ghost" && (
        <div className="absolute inset-0 opacity-0 group-hover:opacity-5 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" style={{ backgroundColor: hoverColor }} />
      )}
    </button>
  );
}

export function CyberCard({ children, className }) {
  return (
    <div className={safeCn("bg-[#0B0C10]/60 border border-[rgba(255,255,255,0.06)] p-3 relative", className)}>
      {children}
    </div>
  );
}

export function CyberLabel({ children, className }) {
    return (
        <label className={safeCn("block text-[9px] uppercase tracking-[0.18em] text-[rgba(230,235,244,0.45)] mb-1.5", className)} style={{ fontFamily: "var(--font-hud)" }}>
            {children}
        </label>
    );
}
