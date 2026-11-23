import { getAPIBaseUrl } from '@/services/environment';
import { getUserID } from '@/utils/access';
import { fetchWithAuth } from '@/utils/fetch';

const getUserDeleteApiEndpoint = () => `${getAPIBaseUrl()}/user/delete`;

export const deleteUser = async () => {
  try {
    const userId = await getUserID();
    if (!userId) {
      throw new Error('Not authenticated');
    }

    await fetchWithAuth(getUserDeleteApiEndpoint(), {
      method: 'DELETE',
    });
  } catch (error) {
    console.error('User deletion failed:', error);
    throw new Error('User deletion failed');
  }
};

export const deleteCloudLibrary = async () => {
  try {
    const userId = await getUserID();
    if (!userId) {
      throw new Error('Not authenticated');
    }

    await fetchWithAuth(`${getAPIBaseUrl()}/user/library`, {
      method: 'DELETE',
    });
  } catch (error) {
    console.error('Cloud library deletion failed:', error);
    throw new Error('Cloud library deletion failed');
  }
};
