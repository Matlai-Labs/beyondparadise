import { defineCollection, z } from 'astro:content';

const reviews = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    permalink: z.string(),
    lodge_id: z.string(),
    lodge_name: z.string(),
    region: z.string(),
    country: z.string(),
    tim_score: z.number().min(0).max(100),
    tim_score_date: z.string(),
    price_per_night_eur: z.number(),
    price_all_in: z.boolean(),
    best_season: z.string(),
    tags: z.array(z.string()),
    hero_image: z.string(),
    hero_alt: z.string(),
    author: z.enum(['tim', 'kim']),
    visit_date: z.string(),
    last_updated: z.string(),
    draft: z.boolean().default(false),
    answer: z.string(),
    faq: z.array(z.object({ q: z.string(), a: z.string() })),
  }),
});

const wildlife = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    permalink: z.string(),
    species_id: z.string(),
    common_name: z.string(),
    scientific_name: z.string(),
    iucn_status: z.string(),
    region: z.string(),
    best_months: z.array(z.number()),
    hero_image: z.string(),
    hero_alt: z.string(),
    author: z.enum(['tim', 'kim']),
    last_updated: z.string(),
    draft: z.boolean().default(false),
    answer: z.string(),
    faq: z.array(z.object({ q: z.string(), a: z.string() })),
  }),
});

const destinations = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    permalink: z.string(),
    destination_id: z.string(),
    region: z.string(),
    country: z.string(),
    best_months: z.array(z.number()),
    hero_image: z.string(),
    hero_alt: z.string(),
    author: z.enum(['tim', 'kim']),
    last_updated: z.string(),
    draft: z.boolean().default(false),
    answer: z.string(),
    faq: z.array(z.object({ q: z.string(), a: z.string() })),
  }),
});

export const collections = { reviews, wildlife, destinations };
