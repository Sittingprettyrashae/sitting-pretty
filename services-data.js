// Service catalog — transcribed verbatim from Ke'Ebonie Hill's StyleSeat profile (Aug 2026).
// Prices, durations, and deposits are hers. Do not edit without her sign-off.
const SERVICES = [
  { cat: "Sew-ins", items: [
    ["2-Part Sew In", "$175", "3 hr", ""],
    ["Frontal Sew In", "$175", "3 hr", ""],
    ["Traditional Sew In", "$150", "2 hr 45 min", "$50 deposit"],
    ["Closure Sew In", "$150", "3 hr", "Closure needed 48 hrs ahead"],
    ["Full Sew In", "$125", "3 hr", "$50 deposit"],
    ["Invisible Part Sew In", "$125", "2 hr 45 min", "$50 deposit"],
    ["Half Up Half Down Sew In", "$125", "3 hr", "$50 deposit"],
    ["Braided Front / Sew In Back", "$125", "4 hr", "$50 deposit"],
    ["Flip Over Method Sew In", "$175", "2 hr 30 min", ""],
    ["Half Braided Mohawk / Sew In Side", "$150", "2 hr 30 min", "$50 deposit"],
    ["Micro-Braids w/ Sew In", "$250", "6 hr", "$75 deposit"]
  ]},
  { cat: "Quickweaves", items: [
    ["Full Quick Weave", "$75", "2 hr", "$35 deposit"],
    ["Traditional Quick Weave", "$80", "2 hr", "$40 deposit"],
    ["Half Up / Half Down Quick Weave", "$80", "1 hr 45 min", "$40 deposit"],
    ["Closure Quick Weave", "$100", "2 hr 30 min", "$50 deposit · unit 48 hrs ahead"],
    ["Frontal Quick Weave", "$125", "2 hr", "$50 deposit · frontal 48 hrs ahead"],
    ["Half Braid / Half Quickweave", "$100", "2 hr", "$50 deposit"],
    ["Flip Over Method Quick Weave", "$100", "2 hr", ""],
    ["Half Braided Mohawk / Quickweave", "$100", "2 hr 30 min", "$50 deposit · braids both sides +$25"]
  ]},
  { cat: "Braids", items: [
    ["Small Knotless Braids", "$250", "8 hr", "$100 deposit · past mid-back +$25"],
    ["Medium Knotless Braids", "$175", "7 hr", "$50 deposit · longer +$50"],
    ["Large Knotless Braids", "$150", "5 hr", "$50 deposit · longer +$20"],
    ["Small Box Braids", "$200", "8 hr", ""],
    ["Medium Box Braids", "$150", "6 hr", "$50 deposit · longer +$25"],
    ["Large Box Braids", "$125", "4 hr", "$50 deposit · hair not provided"],
    ["Jumbo Box Braids", "$100", "4 hr", "$50 deposit"],
    ["Micro Braids", "$250", "8 hr", "$100 deposit"],
    ["Boho Braided Mohawk / Individual Middle", "$175", "6 hr", "$50 deposit"],
    ["Half Scalp / Half Individuals", "$200", "5 hr", "$50 deposit · smaller +$50"],
    ["Individual Braids or Twist w/ Frontal", "$250", "5 hr", ""],
    ["Braided Ponytail", "$85", "3 hr", "$40 deposit · smaller braids +$25"],
    ["2–3 Layer Braids", "$150", "3 hr 30 min", "$50 deposit"],
    ["3 to 10 Braids (Women)", "$80", "3 hr", "$40 deposit"],
    ["2 Goddess Braids", "$50", "2 hr", "$25 deposit"],
    ["Tree Braids", "$150", "3 hr", ""],
    ["Miracle Knots", "$125", "5 hr", ""],
    ["Men Braids", "$25", "1 hr 45 min", "$15 deposit · designs +$5"],
    ["Men / Half Head Box Braids", "$80", "3 hr", "$40 deposit · smaller +$25"],
    ["Kid's Braids (Lil Girls, w/ weave)", "$50", "2 hr", "$25 deposit · ages 5–10"],
    ["Kid's Braids (Girls, no weave)", "$35", "2 hr 30 min", "$15 deposit · under 7"],
    ["Kid's Braids (Lil Boys)", "$30", "2 hr", "Ages 5–8"],
    ["Just Braided Down", "$30", "1 hr", "Foundation for wig, crochet, sew in, or QW"],
    ["Scalp Braids Touch Up", "$45", "1 hr", ""],
    ["Add Hair to Braids or Twist", "$50+", "15 min", "Color match, fit + set"]
  ]},
  { cat: "Crochet", items: [
    ["Crochet", "$65", "1 hr 45 min", "$30 deposit · box braids, locs, Senegalese, passion twist"],
    ["Curly / Wavy Crochet Braids", "$75", "3 hr", "$35 deposit"],
    ["Invisible Crochet Braids", "$80", "2 hr 15 min", ""],
    ["Braided Front & Back Crochet", "$85", "3 hr", "$40 deposit"],
    ["Illusion Crochet Braids", "$85", "3 hr", ""],
    ["Crochet Mohawk", "$100", "2 hr 30 min", "$50 deposit"],
    ["Individuals Front / Crochet Back", "$100", "3 hr", ""],
    ["Individual Crochet Braids", "$125", "5 hr", "$50 deposit"]
  ]},
  { cat: "Wig Installs", items: [
    ["Frontal Wig Install", "$125", "2 hr", "13x4, 13x5"],
    ["Closure Wig Install", "$100", "2 hr", "4x4, 4x5, 4x6"],
    ["Full Wig Install", "$80", "2 hr", "No distinct part"],
    ["U / V-Part Wig Install", "$75", "2 hr", ""],
    ["T-Part Wig Install", "$65", "2 hr", ""],
    ["Synthetic Wig Install", "$65", "1 hr 30 min", ""]
  ]},
  { cat: "Wig Construction", items: [
    ["Frontal Wig (Hand-Stitched)", "$250", "3 hr", "$75 deposit · hair 72 hrs ahead"],
    ["Hand-Stitched Closure Wig", "$200", "3 hr", "Hair 72 hrs ahead"],
    ["Full Wig (Hand-Stitched)", "$150", "3 hr", "Up to 4 bundles"],
    ["Bonded Frontal Wig", "$150", "2 hr", "$50 deposit"],
    ["Bonded Full Wig", "$125", "2 hr", "$50 deposit"],
    ["Bonded Closure Wig", "$120", "2 hr", "Hair 72 hrs ahead"],
    ["Frontal / Closure Replacement", "$80", "1 hr 30 min", ""],
    ["Customize Wig", "$35", "1 hr", "$15 deposit · cut lace, bleach knots, pluck"],
    ["Added Bundle", "$30", "30 min", "Paid in full at booking"],
    ["Add Wig Band / Combs", "$10", "30 min", "Both +$15 · paid in full"]
  ]},
  { cat: "Locs & Dreads", items: [
    ["Micro Loc w/ Extensions", "$700", "8 hr", ""],
    ["Microlocs Twist w/ Extensions", "$650", "5 hr 30 min", "$300 deposit · consultation recommended"],
    ["Micro Locs Twist", "$500", "8 hr", "Consultation needed"],
    ["Handmade Dreadlocks (50–70 locs)", "$250", "8 hr", "80–100 locs +$100 · hair not provided"],
    ["Starter Loc w/ Extensions", "$250", "5 hr", ""],
    ["Micro Loc / Twist Maintenance", "$250", "5 hr", "$100 deposit"],
    ["Dreadlocks Reattachment", "$100+", "4 hr", "$100–$250 depending on count"],
    ["Dread Retwist + Loc Style", "$75", "2 hr 30 min", ""],
    ["Starter Dreadlocks", "$65", "2 hr 45 min", "$30 deposit · smaller +$30"],
    ["Ombre Bundles / Dreads / Natural", "$65", "2 hr 30 min", ""],
    ["Dreadlocks Interlocking", "$60", "2 hr", "$30 deposit · 100+ locs +$25"],
    ["All Over Color (Locs)", "$85", "2 hr 30 min", ""],
    ["Retwist Dreadlocks", "$45", "2 hr 30 min", "$25 deposit"],
    ["Loc Maintenance / Loc Smithing", "$25", "1 hr 45 min", ""],
    ["Loc Style Only", "$25", "1 hr", "Retwist not included"]
  ]},
  { cat: "Twists", items: [
    ["Island Twist", "$200", "6 hr", ""],
    ["Kinky Twist", "$150", "7 hr", "$50 deposit"],
    ["Passion Twist", "$150", "6 hr", "$50 deposit · roots braided"],
    ["Spring Twist", "$150", "5 hr", "$50 deposit"],
    ["Invisible Two Strand Twist", "$150", "3 hr", "Marley hair added"],
    ["Natural Twists (2-Strand)", "$50", "2 hr 30 min", "$25 deposit · extensions +$50"],
    ["Twist Touch Up", "$30", "2 hr 30 min", "First 2 rows all the way around"]
  ]},
  { cat: "Ponytails", items: [
    ["Frontal Ponytail", "$100", "3 hr", "Frontal needed ahead of time"],
    ["Two Extended Ponytails", "$100", "2 hr 30 min", "$50 deposit"],
    ["Extended Ponytail", "$85", "2 hr 30 min", "$45 deposit"],
    ["Closure Ponytail", "$85", "2 hr", "$40 deposit"],
    ["Slick Back Ponytail Braid", "$80", "2 hr", "$40 deposit"]
  ]},
  { cat: "Extensions", items: [
    ["Microlinks Extensions", "$300", "4 hr", "Hair not included"],
    ["Tape-Ins (Full Head)", "$250", "2 hr 30 min", "$50 deposit · straighten + style included"],
    ["Tape-In Extensions (Half Head)", "$150", "2 hr", "$50 deposit"]
  ]},
  { cat: "Natural Hair", items: [
    ["Natural Braided Style", "$50", "2 hr", "No weave"],
    ["Bantu Knots", "$50", "2 hr", "$25 deposit"],
    ["Flat Iron (Natural Hair)", "$50", "2 hr", "$25 deposit · trim included if needed"],
    ["Individual Natural Braids (Men/Women)", "$45", "2 hr", "$25 deposit"]
  ]},
  { cat: "Color", items: [
    ["Coloring Whole Wig / Bundles", "$80", "2 hr 30 min", "Multi-color +$20 · color included"],
    ["All Over Color", "$60", "3 hr", "One color · multi +$20"],
    ["Full Highlights (Weave or Natural)", "$50", "2 hr 15 min", "Multi-color +$25"],
    ["Skunk Strip", "$35", "1 hr 45 min", "$15 deposit · color included"]
  ]},
  { cat: "Curls & Styling", items: [
    ["Wand / Barrel Curls", "$40", "1 hr 30 min", "$20 deposit"],
    ["Shampoo & Blow Dry", "$35", "1 hr 45 min", "$15 deposit"],
    ["Flat Iron (Weave)", "$30", "1 hr", "$15 deposit"],
    ["Style (Other Than Curls)", "$30", "30 min", "Come with clean hair"],
    ["Sectioning / Parting Only", "$50", "1 hr 45 min", "$25 deposit · optional braid down"],
    ["Cut / Split Ends", "$20", "45 min", "$10 deposit"],
    ["Perm (Relaxer Provided)", "$75", "2 hr", "$25 deposit"]
  ]},
  { cat: "Touch-Ups & Takedowns", items: [
    ["Box Braid Maintenance", "$60", "3 hr", "$30 deposit · first 2–3 rows"],
    ["Miracle Knots Touch Up", "$50", "2 hr 30 min", "$25 deposit"],
    ["Sew-In Maintenance", "$45", "1 hr", "$20 deposit"],
    ["Retouch Closure / Frontal / Wig", "$35", "1 hr 30 min", "Curls not included"],
    ["Quickweave Touch Up", "$30", "45 min", "$15 deposit"],
    ["Wig Rejuvenation", "$80", "2 hr 30 min", "$40 deposit · done off your head"],
    ["Touch Up Edges", "$10", "15 min", "Paid in full"],
    ["Takedown Braids / Locs / Crochet", "$85", "1 hr 30 min", ""],
    ["Takedown Micro-Links / Tape-Ins", "$85", "1 hr 45 min", ""],
    ["Takedown Sew In / Wig / Quickweave", "$65", "1 hr", ""],
    ["Takedown Permanent Locs", "$300", "6 hr", "Comb out, wash + trim"]
  ]},
  { cat: "Makeup & Lashes", items: [
    ["Full Face Glam", "$65", "1 hr", "$30 deposit · lashes not included"],
    ["Basic Makeup Look", "$50", "1 hr", "$25 deposit"],
    ["Eyes Only", "$35", "45 min", "$20 deposit"],
    ["Eyebrow Shaping & Filling", "$25", "30 min", "$15 deposit"],
    ["Eyelash Extension Tabs", "$40", "1 hr", "$25 deposit · lashes included"],
    ["Eyelash Strips", "$5", "15 min", "Paid in full · lashes not included"]
  ]},
  { cat: "1-on-1 Classes", items: [
    ["1-1 Wig Install Session", "$125", "2 hr", "Bring a model"],
    ["1-1 Sew In Session", "$100", "2 hr", "Bring a model"],
    ["1-1 Quick Weave Session", "$50", "1 hr 45 min", "Bring a model"],
    ["One-on-One Makeup Lesson", "$50", "2 hr", "Bring a model or be the model"],
    ["Consultation", "$25", "30 min", "$15 deposit · bring pictures!"]
  ]},
  { cat: "Mobile & Travel", items: [
    ["Travel Fee (Under 25 Miles)", "$30", "", "House call — she comes to you"],
    ["Travel Fee (26+ Miles)", "$50", "", "Varies by location"],
    ["Travel Fee (Out of Town / State)", "$200+", "", "Varies by location"]
  ]}
];
