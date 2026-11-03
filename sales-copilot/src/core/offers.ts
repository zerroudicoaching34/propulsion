import type { Offer } from "./types";

// Default knowledge base. Copied into the local database on first launch and
// editable from the "Administration" screen. No price, guarantee or inclusion is
// invented: empty fields mean "à définir".

export const DEFAULT_OFFERS: Offer[] = [
  {
    id: "basic",
    name: "Basic",
    priceLabel: "280 €/mois",
    monthlyPriceMin: 280,
    monthlyPriceMax: 280,
    oneTimePrice: null,
    commitments: "",
    inclusions: [
      "Une séance individuelle hebdomadaire",
      "Application Hexfit",
      "Pratique encadrée",
      "Corrections techniques nécessaires à la sécurité",
    ],
    exclusions: ["Accompagnement nutritionnel individualisé", "Pilotage approfondi"],
    goal: "Régularité et fidélisation",
    guarantee: "",
    active: true,
  },
  {
    id: "advanced",
    name: "Advanced",
    priceLabel: "720 à 1 000 €/mois",
    monthlyPriceMin: 720,
    monthlyPriceMax: 1000,
    oneTimePrice: null,
    commitments: "3, 6 ou 12 mois (envisagés)",
    inclusions: [
      "Deux à trois séances par semaine",
      "Transformation physique individualisée",
      "Programmation",
      "Nutrition",
      "Bilans",
      "Suivi et ajustements",
      "Accompagnement comportemental",
    ],
    exclusions: [],
    goal: "Transformation physique encadrée",
    guarantee: "",
    active: true,
  },
  {
    id: "elite",
    name: "Elite",
    priceLabel: "",
    monthlyPriceMin: null,
    monthlyPriceMax: null,
    oneTimePrice: null,
    commitments: "Conditions et capacité définies contractuellement",
    inclusions: ["Accompagnement Advanced", "Priorité de planification", "Service renforcé (conciergerie premium)"],
    exclusions: [],
    goal: "Conciergerie premium",
    guarantee: "",
    active: true,
  },
  {
    id: "online",
    name: "Online Pilotage",
    priceLabel: "200 €/mois",
    monthlyPriceMin: 200,
    monthlyPriceMax: 200,
    oneTimePrice: null,
    commitments: "Durée d'engagement configurable",
    inclusions: ["Programmation individualisée", "Suivi", "Ajustements", "Accompagnement à distance"],
    exclusions: ["Séances en présentiel"],
    goal: "Pilotage à distance",
    guarantee: "",
    active: true,
  },
  {
    id: "evergreen",
    name: "Evergreen",
    priceLabel: "497 € (paiement unique)",
    monthlyPriceMin: null,
    monthlyPriceMax: null,
    oneTimePrice: 497,
    commitments: "",
    inclusions: [
      "Formation autonome",
      "Parcours transformation physique",
      "Nutrition",
      "Entraînement",
      "Habitudes",
      "Progression",
      "Outils et ressources",
    ],
    exclusions: ["Suivi individuel"],
    goal: "Apprendre la méthode en autonomie",
    guarantee: "",
    active: true,
  },
];

export function defaultOffers(): Offer[] {
  return structuredClone(DEFAULT_OFFERS);
}
