import { Car, MousePointerClick, Layers, Monitor, Disc, Eye, Palette, Sun, Gem, Check, Play, Settings, Plus, FolderOpen, Link2, Shirt, Camera } from "lucide-react";

export const LIVERY_TUTORIAL_STEPS = [
  { id: "welcome", title: "Livery Mode Overview", description: "Welcome to Livery Mode. This workspace is specifically optimized to help you instantly map and preview high-fidelity liveries on 3D vehicles.", icon: Car, target: null, position: "center" },
  { id: "model", title: "1. The Model Generator", description: "Provide a .yft file by dragging it in or clicking 'Select Model'. The engine automatically analyzes the structure and focuses targeting on exterior materials.", icon: MousePointerClick, target: "#panel-model", position: "right" },
  { id: "livery", title: "2. Livery Application", description: "Select your main livery texture. The viewer seamlessly applies it to the vehicle's paint material. Target overrides are fully supported.", icon: Layers, target: "#panel-templates", position: "right" },
  { id: "overlays", title: "3. Window Designs", description: "Need window decals or tinting? Enable 'Glass Overlay' to load a secondary texture targeting the vehicle's window materials.", icon: Disc, target: "#panel-overlays", position: "right" },
  { id: "visibility", title: "4. Exterior Focus", description: "Turn on 'Exterior Only' to instantly hide rendering of the interior, wheels, and suspension systems, giving you an unobstructed view of the body wrapper.", icon: Eye, target: "#panel-visibility", position: "right" },
  { id: "colors", title: "5. Scene Appearance", description: "Build the perfect showcase. Adjust the underlying base body color, dial in the background color, or attach a custom showroom background image.", icon: Palette, target: "#panel-colors", position: "right" },
  { id: "lighting", title: "6. Environment Lighting", description: "Dial in the perfect specular highlights. Adjust light intensity, gloss, and environment shadow direction to evaluate your work in dynamic lighting.", icon: Sun, target: "#panel-scene-lighting", position: "right" },
  { id: "materials", title: "7. Surface Configuration", description: "Fine-tune how light bounces off the livery. You can tweak properties to simulate standard gloss, metallic chrome, rugged plastic, or heavy metal.", icon: Gem, target: "#panel-materials", position: "right" },
  { id: "finish", title: "You're All Set", description: "You've mastered the Livery Engine suite. Perfect your design, snap high-res preview exports from the bottom action bar, and unleash your creativity!", icon: Check, target: null, position: "center" }
];

const openSettingsElevated = () => {
  window.dispatchEvent(new CustomEvent("cortex:open-settings"));
  // Wait for the portal to mount, then elevate
  setTimeout(() => {
    document.querySelector(".settings-page")?.classList.add("is-walkthrough-elevated");
  }, 50);
};

const closeSettingsElevated = () => {
  document.querySelector(".settings-page")?.classList.remove("is-walkthrough-elevated");
  window.dispatchEvent(new CustomEvent("cortex:close-settings"));
};

export const HOME_TUTORIAL_STEPS = [
  { id: "home-welcome", title: "Cortex Studio", description: "Welcome to Cortex Studio, the ultimate tool for previewing and modifying your 3D assets.", icon: Play, target: null, position: "center" },
  { id: "home-modes", title: "1. Quick Start Modes", description: "Choose a dedicated workspace mode to jump right in. Each mode is optimized for specific tasks like Livery painting or side-by-side Multi-Viewer comparisons.", icon: Layers, target: ".hp-left", position: "right" },
  { id: "home-recent", title: "2. Recent Projects", description: "Access your recently opened work quickly right here. It stores full workspace configurations so you can pick up precisely where you left off.", icon: FolderOpen, target: ".hp-right", position: "left" },
  { id: "home-settings-cog", title: "3. Global Settings", description: "The settings gear in the toolbar gives you instant access to your full engine configuration. Click it anytime to customize your workflow.", icon: Settings, target: ".settings-cog", position: "left" },
  { 
    id: "home-settings-dialog", 
    title: "4. System Configuration", 
    description: "Inside the settings panel, you have master control over UI scaling, camera defaults, export paths, hotkey bindings, and visual styling.", 
    icon: Monitor, 
    target: ".settings-dialog", 
    position: "right",
    onEnter: openSettingsElevated,
    onLeave: closeSettingsElevated
  },
  {
    id: "home-settings-nav",
    title: "5. Settings Navigation",
    description: "Use the left sidebar to browse between System, Viewer, Shortcuts, Design, Experimental features, and About — each section has dedicated controls.",
    icon: Layers,
    target: ".settings-nav",
    position: "right",
    onEnter: openSettingsElevated,
    onLeave: closeSettingsElevated
  },
  { id: "finish", title: "You're All Set", description: "You've mastered Cortex Studio's core navigation. Start loading your vehicles and uniforms to see the magic!", icon: Check, target: null, position: "center" }
];

export const EVERYTHING_TUTORIAL_STEPS = [
  { id: "all-welcome", title: "All Mode Overview", description: "Welcome to All Mode. This workspace is designed to effortlessly view any mesh or texture file.", icon: Layers, target: null, position: "center" },
  { id: "all-model", title: "1. Load Any Model", description: "Drop or select any supported model file. The viewer renders the entire model hierarchy without material exclusivity.", icon: MousePointerClick, target: "#panel-model", position: "right" },
  { id: "all-textures", title: "2. Base Texture", description: "Browse and apply individual textures or entirely new texture dictionaries to preview overrides.", icon: Palette, target: "#panel-templates", position: "right" },
  { id: "all-overlays", title: "3. Texture Overlay", description: "Stack a secondary texture over the base mesh to test decaling or dual-layer detailing.", icon: Disc, target: "#panel-overlays", position: "right" },
  { id: "all-appearance", title: "4. Stage Setup", description: "Prepare the perfect background environment and toggle wireframes before taking high-res snaps.", icon: Eye, target: "#panel-colors", position: "right" },
  { id: "all-lighting", title: "5. Environment Lighting", description: "Dial in perfect specular highlights by adjusting light intensity, gloss, and environment shadow direction.", icon: Sun, target: "#panel-scene-lighting", position: "right" },
  { id: "all-materials", title: "6. Surface Configuration", description: "Select the surface type and fine-tune its properties like roughness and clearcoat to simulate real-world materials.", icon: Gem, target: "#panel-materials", position: "right" },
  { id: "all-camera", title: "7. Camera Controls", description: "Easily adjust the camera using predefined angles from the top context bar, and quickly re-center or rotate the model along specific axes.", icon: Camera, target: ".ctx-bar-center", position: "left" },
  { id: "all-capture", title: "8. Capture Preview", description: "Ready to showcase your work? Generate beautiful high-resolution preview screenshots from all angles with a single click.", icon: Camera, target: ".panel-capture-section", position: "left" },
  { id: "finish", title: "You're All Set", description: "You are now ready to make the most out of All Mode. Keep exploring and happy creating!", icon: Check, target: null, position: "center" }
];

export const MULTI_TUTORIAL_STEPS = [
  { id: "multi-welcome", title: "Multi-Viewer", description: "Welcome to Multi Mode. Load two models side-by-side to compare topology, scale, or textures instantly.", icon: Link2, target: null, position: "center" },
  { id: "multi-settings", title: "1. Viewer Layout Structure", description: "Adjust layout constraints here to view models top/bottom, side/side, or split evenly.", icon: Eye, target: "#panel-multi-settings", position: "right" },
  { id: "multi-model1", title: "2. Primary Subject", description: "Load your first model here into Viewer A.", icon: MousePointerClick, target: "#panel-multi-model-1", position: "right" },
  { id: "multi-model2", title: "3. Secondary Subject", description: "Load your second model here into Viewer B to directly compare it against the primary subject.", icon: Gem, target: "#panel-multi-model-2", position: "right" }
];

export const EUP_TUTORIAL_STEPS = [
  { id: "eup-welcome", title: "EUP Mode", description: "Welcome to EUP Mode. This workspace specializes in characterizing and testing uniform and clothing textures efficiently.", icon: Shirt, target: null, position: "center" },
  { id: "eup-model", title: "1. Load Clothing Model", description: "Select a base ped model (e.g. mp_m_freemode_01).", icon: MousePointerClick, target: "#panel-model", position: "right" },
  { id: "eup-textures", title: "2. Uniform Layering", description: "Stack uniform components and multiple textures directly over the base mesh to assemble full outfits.", icon: Palette, target: "#panel-templates", position: "right" }
];

export const TUTORIAL_MAP = {
  livery: LIVERY_TUTORIAL_STEPS,
  everything: EVERYTHING_TUTORIAL_STEPS,
  multi: MULTI_TUTORIAL_STEPS,
  eup: EUP_TUTORIAL_STEPS,
  variants: EVERYTHING_TUTORIAL_STEPS // Fallback
};
