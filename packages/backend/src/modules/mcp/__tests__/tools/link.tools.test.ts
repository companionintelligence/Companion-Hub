import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { LinkTools } from '../../tools/link.tools';

describe('LinkTools', () => {
  let tools: LinkTools;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LinkTools],
    }).compile();

    tools = module.get<LinkTools>(LinkTools);
  });

  it('should be defined', () => {
    expect(tools).toBeDefined();
  });

  // --- DL-1: hub_list_links ---

  describe('hub_list_links', () => {
    // S-DL-1.1: returns { links: [{ id, title, description, url, iconUrl, isVisibleOnGuestDashboard }] }
    it.todo('should return array of links with id, title, description, url, iconUrl, isVisibleOnGuestDashboard');
    it.todo('should return empty array when no links exist');
  });

  // --- DL-2: hub_create_link ---

  describe('hub_create_link', () => {
    // S-DL-2.1: creates link and returns created object
    it.todo('should create a link and return the created link object');

    // S-DL-2.2: title 1-20 chars, url valid, description max 50 chars
    it.todo('should validate title is 1-20 characters');
    it.todo('should validate url is a valid URL');
    it.todo('should validate description is max 50 characters');
    it.todo('should accept optional iconUrl');
    it.todo('should accept optional isVisibleOnGuestDashboard');
  });

  // --- DL-3: hub_edit_link ---

  describe('hub_edit_link', () => {
    // S-DL-3.1: updates the link
    it.todo('should update an existing link');
    it.todo('should require linkId parameter');
    it.todo('should accept partial updates (title, url, description, iconUrl, isVisibleOnGuestDashboard)');
  });

  // --- DL-4: hub_delete_link ---

  describe('hub_delete_link', () => {
    // S-DL-4.1: deletes the link
    it.todo('should delete the specified link');

    // S-DL-4.2: non-existent link returns error
    it.todo('should return error when deleting a non-existent link');
  });
});
